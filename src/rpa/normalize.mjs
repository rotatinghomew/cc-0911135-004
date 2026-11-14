import { createHash } from 'node:crypto';

// 与 docs/protocol.md 约定一致的采集端规范化：业务键去首尾空白，材料编号去首尾空白并
// 统一大写，contact、solvent 去首尾空白，seed 不带保存介质。键顺序固定，序列化结果即规范形。
export function normalizeContent(value = {}) {
  return {
    requestKey: String(value.requestKey ?? '').trim(),
    kind: value.kind,
    material: String(value.material ?? '').trim().toUpperCase(),
    count: Number(value.count),
    solvent: value.kind === 'leaf' ? String(value.solvent ?? '').trim() : '',
    contact: String(value.contact ?? '').trim(),
  };
}

export function canonical(content) {
  return JSON.stringify(normalizeContent(content));
}

export function contentHash(content) {
  return createHash('sha256').update(canonical(content)).digest('hex');
}

// 两侧各自规范化后再比较，用于核对页面摘要、门户记录与回执内容。
export function sameContent(a, b) {
  return canonical(a) === canonical(b);
}

// 日志、执行记录与结果文件不得出现联系人原文；任何要落盘或打印的文本先过这里。
export function redactContact(text, content) {
  const { contact } = normalizeContent(content);
  if (!contact) return String(text);
  return String(text).split(contact).join('<联系人已隐藏>');
}
