import { sameContent } from './normalize.mjs';

// 对查询页结果做认领裁决：只有“完全一致且唯一”的记录才能认领；
// 不存在才可重新登记；多条或内容不一致一律暂停交人工，绝不猜测受理号。
export function decideClaim(records, content) {
  if (records.length === 0) return { verdict: 'absent' };
  if (records.length > 1) {
    return { verdict: 'review', reason: `同键已有 ${records.length} 条记录，无法唯一认领` };
  }
  const [record] = records;
  if (!sameContent(record.content, content)) {
    return { verdict: 'review', reason: '同键已有记录但规范化内容不一致' };
  }
  if (!record.receiptId) {
    return { verdict: 'review', reason: '同键记录缺少受理号，暂停交人工' };
  }
  return { verdict: 'claim', receiptId: record.receiptId };
}
