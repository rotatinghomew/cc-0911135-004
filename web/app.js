const form = document.querySelector('#intake');
const status = document.querySelector('#status');
const config = await (await fetch('/portal/config')).json();
function fields() {
  const value = Object.fromEntries(new FormData(form));
  value.requestKey = value.requestKey.trim(); value.material = value.material.trim().toUpperCase();
  value.count = Number(value.count); value.contact = value.contact.trim();
  value.solvent = value.kind === 'leaf' ? value.solvent.trim() : '';
  return value;
}
function step(number) {
  for (const position of [1, 2, 3]) document.querySelector(`#step${position}`).hidden = position !== number;
}
form.elements.kind.onchange = () => {
  form.elements.count.value = ''; form.elements.contact.value = ''; form.elements.solvent.value = '';
  document.querySelector('#solvent-row').hidden = form.elements.kind.value !== 'leaf';
  step(1);
};
document.querySelector('#next').onclick = () => {
  if (!form.elements.requestKey.value.trim() || !form.elements.material.value.trim()) { status.textContent = '业务键和材料编号必填'; return; }
  document.querySelector('#solvent-row').hidden = form.elements.kind.value !== 'leaf';
  step(2); status.textContent = '请填写送检条件';
};
document.querySelector('#review').onclick = () => {
  const value = fields();
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > config.maxCount || !value.contact || value.kind === 'leaf' && !value.solvent) {
    status.textContent = '送检条件尚未通过校验'; return;
  }
  document.querySelector('#summary').textContent = JSON.stringify(value, null, 2);
  step(3); status.textContent = '核对无误后再提交';
};
form.onsubmit = async event => {
  event.preventDefault();
  document.querySelector('#commit').disabled = true;
  try {
    const response = await fetch('/portal/submit', { method: 'POST', body: JSON.stringify(fields()) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    document.querySelector('#receipt').textContent = JSON.stringify(value, null, 2);
    status.textContent = '登记完成';
  } catch (error) { status.textContent = '提交结果不明，请先查询登记：' + error.message; }
  finally { document.querySelector('#commit').disabled = false; }
};
document.querySelector('#search').onsubmit = async event => {
  event.preventDefault();
  const key = document.querySelector('#search').elements.key.value.trim();
  const records = await (await fetch('/portal/search?key=' + encodeURIComponent(key))).json();
  const matches = document.querySelector('#matches'); matches.replaceChildren();
  for (const record of records) { const node = document.createElement('pre'); node.textContent = JSON.stringify(record, null, 2); matches.append(node); }
  const count = document.createElement('p'); count.textContent = `查询记录数 ${records.length}`; matches.prepend(count);
};
