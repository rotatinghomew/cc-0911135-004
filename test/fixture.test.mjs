import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

test('动态必填字段及规范化', async () => withSite(async site => {
  const content = { requestKey: ' X ', kind: 'leaf', material: ' m-1 ', count: 2, contact: ' 演练 ' };
  assert.equal((await fetch(site.url + '/portal/submit', { method: 'POST', body: JSON.stringify(content) })).status, 422);
  const result = await (await fetch(site.url + '/portal/submit', { method: 'POST', body: JSON.stringify({ ...content, solvent: '水' }) })).json();
  assert.equal(result.content.material, 'M-1'); assert.equal(result.content.requestKey, 'X');
}));
test('源端无幂等承诺且可查询所有匹配', async () => withSite(async site => {
  const content = { requestKey: 'DUP', kind: 'seed', material: 'M1', count: 1, contact: '演练' };
  for (const attempt of [1, 2]) assert.equal((await fetch(site.url + '/portal/submit', { method: 'POST', body: JSON.stringify(content) })).status, 201);
  const records = await (await fetch(site.url + '/portal/search?key=DUP')).json();
  assert.equal(records.length, 2); assert.notEqual(records[0].receiptId, records[1].receiptId);
}));
test('无受理号的成功和泄露联系人回执被拒绝', () => {
  assert.throws(() => verify({ items: [{ requestKey: 'X', status: 'accepted', contentHash: 'a'.repeat(64), contact: '明文' }] }));
});

test('提交响应丢失但查询页面的数据源已有真实回执', async () => withSite(async site => {
  await control(site, { lostResponseOnce: true });
  const value = { requestKey: 'LOST', kind: 'seed', material: 'M9', count: 1, contact: '演练' };
  await assert.rejects(() => fetch(site.url + '/portal/submit', { method: 'POST', body: JSON.stringify(value) }));
  const found = await (await fetch(site.url + '/portal/search?key=LOST')).json();
  assert.equal(found.length, 1); assert.equal(found[0].receiptId, 'INTAKE-1');
}));
