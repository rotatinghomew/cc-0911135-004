import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeContent, contentHash, sameContent, redactContact } from '../src/rpa/normalize.mjs';
import { decideClaim } from '../src/rpa/reconcile.mjs';
import { Journal } from '../src/rpa/journal.mjs';
import { processItem, buildOutput } from '../src/rpa/collector.mjs';
import { verify } from '../lib/verify.mjs';

const temporary = () => mkdtemp(join(tmpdir(), 'rpa-test-'));
const sample = { requestKey: 'R-1', kind: 'leaf', material: ' m-1 ', count: 2, solvent: ' 水 ', contact: ' 联系人甲 ' };

test('规范化与内容哈希', () => {
  const content = normalizeContent({ requestKey: ' A ', kind: 'seed', material: ' m-1 ', count: '2', solvent: '忽略', contact: ' 甲 ' });
  assert.deepEqual(content, { requestKey: 'A', kind: 'seed', material: 'M-1', count: 2, solvent: '', contact: '甲' });
  assert.match(contentHash(content), /^[a-f0-9]{64}$/);
  assert.ok(sameContent(content, { ...content, material: 'm-1' }));
  assert.ok(!sameContent(content, { ...content, count: 3 }));
});

test('联系人原文脱敏', () => {
  const content = normalizeContent(sample);
  assert.equal(redactContact('错误：联系人甲 的输入', content), '错误：<联系人已隐藏> 的输入');
  assert.equal(redactContact('无敏感信息', content), '无敏感信息');
});

test('认领裁决：唯一一致才认领，其余暂停或缺席', () => {
  const content = normalizeContent(sample);
  assert.deepEqual(decideClaim([], content), { verdict: 'absent' });
  assert.deepEqual(decideClaim([{ receiptId: 'INTAKE-1', content }], content),
    { verdict: 'claim', receiptId: 'INTAKE-1' });
  assert.equal(decideClaim([{ receiptId: 'INTAKE-1', content: { ...content, count: 9 } }], content).verdict, 'review');
  assert.equal(decideClaim([{ receiptId: 'INTAKE-1', content }, { receiptId: 'INTAKE-2', content }], content).verdict, 'review');
  assert.equal(decideClaim([{ content }], content).verdict, 'review');
});

test('执行记录原子读写，损坏记录转为暂停', async () => {
  const directory = await temporary();
  const journal = new Journal(directory);
  assert.equal(await journal.read('K-1'), null);
  await journal.write({ requestKey: 'K-1', contentHash: 'a'.repeat(64), stage: 'intent', attempts: 0 });
  const state = await journal.read('K-1');
  assert.equal(state.stage, 'intent');
  assert.ok(state.updatedAt);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
  await writeFile(join(directory, `state-${encodeURIComponent('K-2')}.json`), '{broken');
  assert.equal((await journal.read('K-2')).stage, 'corrupt');
});

test('提交结果不明且查询无记录：重新登记，达到上限后暂停', async () => {
  const journal = new Journal(await temporary());
  let clicks = 0;
  const ops = {
    queryByKey: async () => [],
    fillToSummary: async () => normalizeContent(sample),
    clickCommit: async () => { clicks += 1; },
    awaitOutcome: async () => ({ outcome: 'uncertain' }),
  };
  const item = await processItem({ page: null, url: 'http://portal', journal, ops }, sample);
  assert.equal(item.status, 'review');
  assert.match(item.reason, /多次提交结果不明/);
  assert.equal(clicks, 2);
  const state = await journal.read('R-1');
  assert.equal(state.stage, 'review');
  assert.equal(state.attempts, 2);
});

test('提交结果不明后查询到唯一一致记录：认领，不再点击', async () => {
  const journal = new Journal(await temporary());
  let clicks = 0;
  let queries = 0;
  const ops = {
    queryByKey: async () => ++queries === 1 ? [] : [{ receiptId: 'INTAKE-3', content: normalizeContent(sample) }],
    fillToSummary: async () => normalizeContent(sample),
    clickCommit: async () => { clicks += 1; },
    awaitOutcome: async () => ({ outcome: 'uncertain' }),
  };
  const item = await processItem({ page: null, url: 'http://portal', journal, ops }, sample);
  assert.equal(item.status, 'accepted');
  assert.equal(item.receiptId, 'INTAKE-3');
  assert.equal(clicks, 1);
});

test('崩溃恢复：执行记录显示结果未知，恢复认领唯一一致记录且不再点击', async () => {
  const journal = new Journal(await temporary());
  const content = normalizeContent(sample);
  await journal.write({ requestKey: 'R-1', contentHash: contentHash(content), stage: 'submit-uncertain', attempts: 1 });
  let clicks = 0;
  const ops = {
    queryByKey: async () => [{ receiptId: 'INTAKE-7', content }],
    clickCommit: async () => { clicks += 1; },
  };
  const item = await processItem({ page: null, url: 'http://portal', journal, ops }, sample);
  assert.equal(item.status, 'accepted');
  assert.equal(item.receiptId, 'INTAKE-7');
  assert.equal(clicks, 0);
});

test('执行期间交接内容变化：暂停而不是继续', async () => {
  const journal = new Journal(await temporary());
  await journal.write({ requestKey: 'R-1', contentHash: 'f'.repeat(64), stage: 'submit-uncertain', attempts: 1 });
  const item = await processItem({ page: null, url: 'http://portal', journal, ops: {} }, sample);
  assert.equal(item.status, 'review');
  assert.match(item.reason, /发生变化/);
});

test('结果文件不含联系人明文且通过业务不变量校验', () => {
  const output = buildOutput([
    { requestKey: 'A', contentHash: 'a'.repeat(64), status: 'accepted', receiptId: 'INTAKE-1' },
    { requestKey: 'B', contentHash: 'b'.repeat(64), status: 'review', reason: '同键已有 2 条记录' },
    { requestKey: 'C', contentHash: 'c'.repeat(64), status: 'failed', reason: '表单校验拒绝' },
  ], 'http://portal');
  verify(output);
  assert.ok(!JSON.stringify(output).includes('联系人甲'));
  assert.deepEqual(output.summary, { accepted: 1, review: 1, failed: 1, total: 3 });
});
