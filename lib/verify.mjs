import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(Array.isArray(value.items));
  assert.equal(new Set(value.items.map(item => item.requestKey)).size, value.items.length);
  for (const item of value.items) {
    assert.ok(['accepted', 'review', 'failed'].includes(item.status));
    assert.match(item.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(item.contact, undefined);
    if (item.status === 'accepted') assert.ok(item.receiptId);
    else assert.ok(item.reason);
  }
}
