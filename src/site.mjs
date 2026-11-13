import { readFile } from 'node:fs/promises';
import { serve, json, text, body } from '../lib/http.mjs';
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
export function normalize(value) {
  return { requestKey: String(value.requestKey || '').trim(), kind: value.kind,
    material: String(value.material || '').trim().toUpperCase(), count: Number(value.count),
    solvent: value.kind === 'leaf' ? String(value.solvent || '').trim() : '', contact: String(value.contact || '').trim() };
}
export async function createSite(port = 0) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/') { text(response, 200, html, { 'content-type': 'text/html; charset=utf-8' }); return true; }
    if (url.pathname === '/app.js') { text(response, 200, script, { 'content-type': 'text/javascript' }); return true; }
    if (url.pathname === '/portal/config') { json(response, 200, { leafNeedsSolvent: true, maxCount: 20 }); return true; }
    if (url.pathname === '/portal/search') {
      json(response, 200, state.records.filter(record => record.content.requestKey === url.searchParams.get('key'))); return true;
    }
    if (url.pathname !== '/portal/submit' || request.method !== 'POST') return false;
    const content = normalize(await body(request));
    if (!content.requestKey || !['seed', 'leaf'].includes(content.kind) || !content.material ||
      !Number.isInteger(content.count) || content.count < 1 || content.count > 20 || !content.contact || content.kind === 'leaf' && !content.solvent) {
      json(response, 422, { error: '登记字段未通过校验' }); return true;
    }
    const receipt = { receiptId: `INTAKE-${state.records.length + 1}`, content };
    state.records.push(receipt);
    if (state.lostResponseOnce) { state.lostResponseOnce = false; response.destroy(); return true; }
    json(response, 201, receipt); return true;
  }, { records: [], lostResponseOnce: false }, port);
}
