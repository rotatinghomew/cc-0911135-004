import { normalizeContent, contentHash, sameContent, redactContact } from './normalize.mjs';
import { decideClaim } from './reconcile.mjs';
import { ValidationRejection, fillToSummary, clickCommit, awaitOutcome, queryByKey } from './pages.mjs';

// 同一份资料在一次执行中最多点击两次确认提交：首次 + 查询确认不存在后的一次重新登记。
const MAX_SUBMIT_ATTEMPTS = 2;

const pageOps = { fillToSummary, clickCommit, awaitOutcome, queryByKey };

// 崩溃演练注入点，仅演练使用：before-submit（点击前）、after-submit（点击后）、
// after-receipt（看到回执但尚未落账）。正常运行为空，不影响流程。
function crash(point) {
  if (process.env.INTAKE_CRASH_AT === point) {
    console.error(`演练：在 ${point} 注入采集端崩溃`);
    process.exit(2);
  }
}

// 处理一条交接资料。所有跨重启状态只来自执行记录与门户查询，不依赖内存进度。
export async function processItem(context, raw) {
  const { page, url, journal } = context;
  const ops = { ...pageOps, ...context.ops };
  const log = context.log ?? (() => {});
  const content = normalizeContent(raw);
  const base = { requestKey: content.requestKey, contentHash: contentHash(content) };
  const note = text => log(redactContact(text, content));

  if (!content.requestKey) return { ...base, status: 'failed', reason: '业务键为空，无法登记' };
  if (!['seed', 'leaf'].includes(content.kind)) {
    return { ...base, status: 'failed', reason: '样本类型不是门户支持的取值' };
  }

  const prior = await journal.read(content.requestKey);
  if (prior?.stage === 'corrupt') return { ...base, status: 'review', reason: prior.reason };
  if (prior && prior.contentHash !== base.contentHash && prior.stage !== 'failed') {
    // 校验失败过的资料允许修正交接清单后重录；其余阶段内容变化一律暂停。
    const reason = '交接内容在执行期间发生变化，暂停交人工';
    await journal.write({ ...base, stage: 'review', reason, attempts: prior.attempts ?? 0 });
    note(`${content.requestKey}：暂停，${reason}`);
    return { ...base, status: 'review', reason };
  }
  if (prior?.stage === 'accepted') return { ...base, status: 'accepted', receiptId: prior.receiptId };
  if (prior?.stage === 'review') return { ...base, status: 'review', reason: prior.reason };
  if (prior?.stage === 'failed') return { ...base, status: 'failed', reason: prior.reason };

  let attempts = prior?.attempts ?? 0;
  if (!prior) await journal.write({ ...base, stage: 'intent', attempts });

  // 先查后登：无论首次还是崩溃恢复，都先通过查询页确认业务键当前状态。
  const existing = decideClaim(await ops.queryByKey(page, url, content.requestKey), content);
  if (existing.verdict === 'claim') {
    await journal.write({ ...base, stage: 'accepted', receiptId: existing.receiptId, attempts });
    note(`${content.requestKey}：认领既有回执 ${existing.receiptId}`);
    return { ...base, status: 'accepted', receiptId: existing.receiptId };
  }
  if (existing.verdict === 'review') {
    await journal.write({ ...base, stage: 'review', reason: existing.reason, attempts });
    note(`${content.requestKey}：暂停，${existing.reason}`);
    return { ...base, status: 'review', reason: existing.reason };
  }

  while (attempts < MAX_SUBMIT_ATTEMPTS) {
    let summary;
    try {
      summary = await ops.fillToSummary(page, url, content);
    } catch (error) {
      if (!(error instanceof ValidationRejection)) throw error;
      const reason = `表单校验拒绝：${error.message}`;
      await journal.write({ ...base, stage: 'failed', reason, attempts });
      note(`${content.requestKey}：失败，${reason}`);
      return { ...base, status: 'failed', reason };
    }
    if (!sameContent(summary, content)) {
      const reason = '页面摘要与业务输入不一致，暂停交人工';
      await journal.write({ ...base, stage: 'review', reason, attempts });
      note(`${content.requestKey}：暂停，${reason}`);
      return { ...base, status: 'review', reason };
    }
    attempts += 1;
    // 点击确认提交前持久化“结果未知”；此后任何崩溃都靠查询页恢复，不靠内存。
    await journal.write({ ...base, stage: 'submit-uncertain', attempts });
    crash('before-submit');
    await ops.clickCommit(page, { crashAfterSend: process.env.INTAKE_CRASH_AT === 'after-submit' });
    crash('after-submit');
    const outcome = await ops.awaitOutcome(page);
    if (outcome.outcome === 'receipt') crash('after-receipt');
    // 看到回执不等于唯一：浏览器可能在连接断开后自动重放提交，制造同键多条记录。
    // 无论结果如何，都通过查询页确认“完全一致且唯一”才认领，不猜测受理号。
    note(outcome.outcome === 'receipt'
      ? `${content.requestKey}：页面已显示回执，通过查询页确认唯一性`
      : `${content.requestKey}：提交结果不明，通过查询页核对`);
    const check = decideClaim(await ops.queryByKey(page, url, content.requestKey), content);
    if (check.verdict === 'claim') {
      await journal.write({ ...base, stage: 'accepted', receiptId: check.receiptId, attempts });
      note(`${content.requestKey}：认领回执 ${check.receiptId}`);
      return { ...base, status: 'accepted', receiptId: check.receiptId };
    }
    if (check.verdict === 'review') {
      await journal.write({ ...base, stage: 'review', reason: check.reason, attempts });
      note(`${content.requestKey}：暂停，${check.reason}`);
      return { ...base, status: 'review', reason: check.reason };
    }
    note(`${content.requestKey}：查询确认无记录，重新登记`);
  }
  const reason = '多次提交结果不明，暂停交人工';
  await journal.write({ ...base, stage: 'review', reason, attempts });
  note(`${content.requestKey}：暂停，${reason}`);
  return { ...base, status: 'review', reason };
}

// 逐条处理交接清单，返回与清单同序的结果项。单条异常不影响其余资料。
export async function runIntake({ handover, url, journal, browser, log = () => {}, ops }) {
  const page = await browser.newPage();
  const items = [];
  try {
    const occurrences = new Map();
    for (const raw of handover) {
      const key = String(raw?.requestKey ?? '').trim();
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
    for (const raw of handover) {
      const content = normalizeContent(raw);
      const base = { requestKey: content.requestKey, contentHash: contentHash(content) };
      if (occurrences.get(content.requestKey) > 1) {
        const reason = '交接清单中业务键重复，暂停交人工';
        items.push({ ...base, status: 'review', reason });
        log(`${content.requestKey || '（空业务键）'}：暂停，${reason}`);
        continue;
      }
      try {
        items.push(await processItem({ page, url, journal, log, ops }, raw));
      } catch (error) {
        const reason = `页面操作异常：${redactContact(String(error.message).split('\n')[0], content)}`;
        items.push({ ...base, status: 'failed', reason });
        log(`${content.requestKey}：失败，${reason}`);
      }
    }
  } finally {
    await page.close();
  }
  return items;
}

export function buildOutput(items, url) {
  const count = status => items.filter(item => item.status === status).length;
  return {
    portal: url,
    generatedAt: new Date().toISOString(),
    summary: { accepted: count('accepted'), review: count('review'), failed: count('failed'), total: items.length },
    items,
  };
}
