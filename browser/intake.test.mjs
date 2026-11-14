import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createSite } from '../src/site.mjs';
import { normalizeContent } from '../src/rpa/normalize.mjs';
import { Journal } from '../src/rpa/journal.mjs';
import { runIntake, buildOutput } from '../src/rpa/collector.mjs';
import { verify } from '../lib/verify.mjs';

const CLI = fileURLToPath(new URL('../tools/intake.mjs', import.meta.url));
const temporary = () => mkdtemp(join(tmpdir(), 'intake-test-'));

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function withBrowser(operation) {
  const browser = await chromium.launch({ headless: true });
  try { await operation(browser); } finally { await browser.close(); }
}
async function control(site, value) {
  await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}
function collect(site, browser, handover, stateDir) {
  return runIntake({ handover, url: site.url, journal: new Journal(stateDir), browser, log: () => {} });
}
function submitCount(site) {
  return site.audit.filter(entry => entry.path === '/portal/submit').length;
}
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}
async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待条件超时');
}
async function writeHandover(directory, rows) {
  const path = join(directory, 'handover.json');
  await writeFile(path, JSON.stringify(rows));
  return path;
}

test('正常登记：seed 与 leaf 都拿到真实回执，leaf 介质进入回执内容', async () => withSite(async site => withBrowser(async browser => {
  const items = await collect(site, browser, [
    { requestKey: 'REQ-01', kind: 'seed', material: 'm-001', count: 3, contact: '演练甲' },
    { requestKey: 'REQ-02', kind: 'leaf', material: 'M-002', count: 2, solvent: '水', contact: '演练乙' },
  ], await temporary());
  assert.deepEqual(items.map(item => item.status), ['accepted', 'accepted']);
  assert.equal(items[0].receiptId, 'INTAKE-1');
  assert.equal(items[1].receiptId, 'INTAKE-2');
  verify(buildOutput(items, site.url));
  const [record] = await (await fetch(site.url + '/portal/search?key=REQ-02')).json();
  assert.equal(record.content.solvent, '水');
  assert.equal(record.content.material, 'M-002');
})));

test('条件字段：类型切换清空后续字段，采集端按当前类型重填并登记', async () => withSite(async site => withBrowser(async browser => {
  const page = await browser.newPage();
  await page.goto(site.url);
  await page.getByLabel('交接业务键').fill('SWITCH-1');
  await page.getByLabel('材料编号').fill('M-100');
  // 第一步上切换类型：清空后续字段并停留在第一步，介质字段按类型动态出现
  await page.getByLabel('样本类型').selectOption('leaf');
  assert.ok(await page.locator('#step1').isVisible());
  assert.equal(await page.locator('#solvent-row').getAttribute('hidden'), null);
  await page.getByLabel('样本类型').selectOption('seed');
  assert.notEqual(await page.locator('#solvent-row').getAttribute('hidden'), null);
  await page.close();
  // 采集端先选定类型再填后续字段：leaf 介质进入回执，seed 不带介质
  const items = await collect(site, browser, [
    { requestKey: 'SWITCH-1', kind: 'leaf', material: 'M-100', count: 5, solvent: '乙醇', contact: '演练丙' },
    { requestKey: 'SWITCH-2', kind: 'seed', material: 'M-101', count: 1, contact: '演练丙' },
  ], await temporary());
  assert.deepEqual(items.map(item => item.status), ['accepted', 'accepted']);
  const [leaf] = await (await fetch(site.url + '/portal/search?key=SWITCH-1')).json();
  assert.equal(leaf.content.solvent, '乙醇');
  const [seed] = await (await fetch(site.url + '/portal/search?key=SWITCH-2')).json();
  assert.equal(seed.content.solvent, '');
})));

test('校验拒绝：叶片缺介质与数量超限停留在校验阶段，没有受理号', async () => withSite(async site => withBrowser(async browser => {
  const items = await collect(site, browser, [
    { requestKey: 'BAD-1', kind: 'leaf', material: 'M-201', count: 2, contact: '演练丁' },
    { requestKey: 'BAD-2', kind: 'seed', material: 'M-202', count: 25, contact: '演练戊' },
  ], await temporary());
  assert.deepEqual(items.map(item => item.status), ['failed', 'failed']);
  assert.match(items[0].reason, /校验/);
  assert.match(items[1].reason, /校验/);
  assert.equal(items[0].receiptId, undefined);
  assert.equal(submitCount(site), 0);
  assert.equal(site.state.records.length, 0);
  verify(buildOutput(items, site.url));
})));

test('提交后连接断开：浏览器自动重放造成同键两条记录，暂停交人工而不是认领其一', async () => withSite(async site => {
  await control(site, { lostResponseOnce: true });
  await withBrowser(async browser => {
    const stateDir = await temporary();
    const items = await collect(site, browser, [
      { requestKey: 'LOST-1', kind: 'seed', material: 'M-301', count: 1, contact: '演练己' },
    ], stateDir);
    // 事故复现：服务端第一次成功后断连，浏览器自动重放提交，同一份样品占了两个受理号
    assert.equal(site.state.records.length, 2);
    assert.equal(submitCount(site), 2);
    // 采集端只点击了一次（重放是浏览器行为），查到多条后暂停，不任意认领
    assert.equal(items[0].status, 'review');
    assert.match(items[0].reason, /2 条/);
    assert.equal(items[0].receiptId, undefined);
    const state = await new Journal(stateDir).read('LOST-1');
    assert.equal(state.stage, 'review');
    assert.equal(state.attempts, 1);
    verify(buildOutput(items, site.url));
  });
}));

test('同键已有完全一致记录：直接认领，不再提交', async () => withSite(async site => {
  const content = normalizeContent({ requestKey: 'SAME-1', kind: 'seed', material: 'M-401', count: 1, contact: '演练庚' });
  await control(site, { records: [{ receiptId: 'INTAKE-1', content }] });
  await withBrowser(async browser => {
    const items = await collect(site, browser, [
      { requestKey: 'SAME-1', kind: 'seed', material: 'M-401', count: 1, contact: '演练庚' },
    ], await temporary());
    assert.equal(items[0].status, 'accepted');
    assert.equal(items[0].receiptId, 'INTAKE-1');
    assert.equal(submitCount(site), 0);
    assert.equal(site.state.records.length, 1);
  });
}));

test('多记录与同键冲突：暂停交人工，不任意认领', async () => withSite(async site => {
  const base = { kind: 'seed', count: 1, solvent: '', contact: '演练辛' };
  await control(site, { records: [
    { receiptId: 'INTAKE-1', content: normalizeContent({ ...base, requestKey: 'MULTI-1', material: 'M-501' }) },
    { receiptId: 'INTAKE-2', content: normalizeContent({ ...base, requestKey: 'MULTI-1', material: 'M-501' }) },
    { receiptId: 'INTAKE-3', content: normalizeContent({ ...base, requestKey: 'CONFLICT-1', material: 'M-999' }) },
  ] });
  await withBrowser(async browser => {
    const items = await collect(site, browser, [
      { requestKey: 'MULTI-1', kind: 'seed', material: 'M-501', count: 1, contact: '演练辛' },
      { requestKey: 'CONFLICT-1', kind: 'seed', material: 'M-502', count: 1, contact: '演练辛' },
      { requestKey: 'FRESH-1', kind: 'seed', material: 'M-503', count: 1, contact: '演练辛' },
    ], await temporary());
    assert.deepEqual(items.map(item => item.status), ['review', 'review', 'accepted']);
    assert.match(items[0].reason, /2 条/);
    assert.match(items[1].reason, /不一致/);
    assert.equal(items[0].receiptId, undefined);
    assert.equal(items[1].receiptId, undefined);
    assert.equal(items[2].receiptId, 'INTAKE-4');
    assert.equal(submitCount(site), 1);
    verify(buildOutput(items, site.url));
  });
}));

test('点击前崩溃：恢复后先查询确认不存在再登记', async () => withSite(async site => {
  const directory = await temporary();
  const stateDir = join(directory, 'state');
  const out = join(directory, 'out.json');
  const handover = await writeHandover(directory, [
    { requestKey: 'CRASH-1', kind: 'seed', material: 'M-601', count: 1, contact: '演练子' },
  ]);
  const args = ['--handover', handover, '--out', out, '--url', site.url, '--state-dir', stateDir];
  const first = await runCli(args, { INTAKE_CRASH_AT: 'before-submit' });
  assert.equal(first.code, 2);
  assert.equal(site.state.records.length, 0);
  const second = await runCli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(site.state.records.length, 1);
  assert.equal(submitCount(site), 1);
  const output = JSON.parse(await readFile(out, 'utf8'));
  verify(output);
  assert.equal(output.items[0].status, 'accepted');
  assert.equal(output.items[0].receiptId, 'INTAKE-1');
}));

test('点击后崩溃：恢复后认领既有回执，不制造新受理', async () => withSite(async site => {
  const directory = await temporary();
  const stateDir = join(directory, 'state');
  const out = join(directory, 'out.json');
  const handover = await writeHandover(directory, [
    { requestKey: 'CRASH-2', kind: 'leaf', material: 'M-602', count: 2, solvent: '水', contact: '演练丑' },
  ]);
  const args = ['--handover', handover, '--out', out, '--url', site.url, '--state-dir', stateDir];
  const first = await runCli(args, { INTAKE_CRASH_AT: 'after-submit' });
  assert.equal(first.code, 2);
  // 崩溃发生在门户处理完提交之后、本地落账之前
  await waitFor(() => site.state.records.length === 1);
  const second = await runCli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(site.state.records.length, 1);
  assert.equal(submitCount(site), 1);
  const output = JSON.parse(await readFile(out, 'utf8'));
  verify(output);
  assert.equal(output.items[0].status, 'accepted');
  assert.equal(output.items[0].receiptId, 'INTAKE-1');
}));

test('看到回执后崩溃：恢复认领同一受理号，不重复登记', async () => withSite(async site => {
  const directory = await temporary();
  const stateDir = join(directory, 'state');
  const out = join(directory, 'out.json');
  const handover = await writeHandover(directory, [
    { requestKey: 'CRASH-3', kind: 'seed', material: 'M-603', count: 3, contact: '演练寅' },
  ]);
  const args = ['--handover', handover, '--out', out, '--url', site.url, '--state-dir', stateDir];
  const first = await runCli(args, { INTAKE_CRASH_AT: 'after-receipt' });
  assert.equal(first.code, 2);
  assert.equal(site.state.records.length, 1);
  const second = await runCli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(site.state.records.length, 1);
  assert.equal(submitCount(site), 1);
  const output = JSON.parse(await readFile(out, 'utf8'));
  verify(output);
  assert.equal(output.items[0].status, 'accepted');
  assert.equal(output.items[0].receiptId, 'INTAKE-1');
}));

test('一条命令：临时交接清单到 intake-receipts.json', async () => {
  const directory = await temporary();
  const out = join(directory, 'intake-receipts.json');
  const handover = await writeHandover(directory, [
    { requestKey: 'CMD-1', kind: 'seed', material: 'M-701', count: 3, contact: '演练卯' },
    { requestKey: 'CMD-2', kind: 'leaf', material: 'M-702', count: 2, solvent: '水', contact: '演练辰' },
  ]);
  const result = await runCli(['--handover', handover, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(await readFile(out, 'utf8'));
  verify(output);
  assert.deepEqual(output.items.map(item => item.status), ['accepted', 'accepted']);
  assert.match(result.stdout, /受理 2，暂停 0，失败 0/);
});

test('暂停与失败显式列出并体现在退出码', async () => withSite(async site => {
  await control(site, { records: [
    { receiptId: 'INTAKE-1', content: normalizeContent({ requestKey: 'KEY-X', kind: 'seed', material: 'M-801', count: 1, contact: '演练巳' }) },
  ] });
  const directory = await temporary();
  const out = join(directory, 'out.json');
  const handover = await writeHandover(directory, [
    { requestKey: 'KEY-X', kind: 'seed', material: 'M-802', count: 1, contact: '演练巳' },
    { requestKey: 'KEY-Y', kind: 'leaf', material: 'M-803', count: 1, contact: '演练午' },
  ]);
  const result = await runCli(['--handover', handover, '--out', out, '--url', site.url,
    '--state-dir', join(directory, 'state')]);
  assert.equal(result.code, 7);
  assert.match(result.stdout, /暂停 KEY-X/);
  assert.match(result.stdout, /失败 KEY-Y/);
  const output = JSON.parse(await readFile(out, 'utf8'));
  verify(output);
  assert.deepEqual(output.summary, { accepted: 0, review: 1, failed: 1, total: 2 });
}));

test('日志、结果文件与执行记录都不出现联系人明文', async () => withSite(async site => {
  const directory = await temporary();
  const stateDir = join(directory, 'state');
  const out = join(directory, 'out.json');
  const handover = await writeHandover(directory, [
    { requestKey: 'PRIV-1', kind: 'seed', material: 'M-901', count: 1, contact: '保密联系人甲某' },
  ]);
  const result = await runCli(['--handover', handover, '--out', out, '--url', site.url, '--state-dir', stateDir]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('保密联系人甲某'));
  assert.ok(!result.stderr.includes('保密联系人甲某'));
  assert.ok(!(await readFile(out, 'utf8')).includes('保密联系人甲某'));
  for (const name of await readdir(stateDir)) {
    assert.ok(!(await readFile(join(stateDir, name), 'utf8')).includes('保密联系人甲某'));
  }
}));
