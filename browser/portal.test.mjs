import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createSite } from '../src/site.mjs';

test('真实浏览器完成一次门户交互', async () => {
  const site = await createSite();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(site.url);
    
await page.getByLabel('交接业务键').fill('BROWSER-1');
await page.getByLabel('材料编号').fill('m-001');
await page.getByRole('button', { name: '下一步' }).click();
await page.getByLabel('样品数量').fill('2');
await page.getByLabel('联系人').fill('本地操作员');
await page.getByRole('button', { name: '核对摘要' }).click();
assert.match(await page.locator('#summary').innerText(), /M-001/);
await page.getByRole('button', { name: '确认提交' }).click();
await page.locator('#receipt').filter({ hasText: 'INTAKE-1' }).waitFor();
await page.getByLabel('查询业务键').fill('BROWSER-1');
await page.getByRole('button', { name: '查询登记' }).click();
await page.locator('#matches').filter({ hasText: '查询记录数 1' }).waitFor();

  } finally {
    await browser.close();
    await site.close();
  }
});
