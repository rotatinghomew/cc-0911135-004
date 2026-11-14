// 只通过浏览器页面操作门户：分步登记表单、提交前摘要、查询登记，不直接调用内部接口。

export class ValidationRejection extends Error {} // 必填或格式校验未通过，停留在当前步
export class PageStateError extends Error {}      // 页面未呈现站点配置承诺的结构

async function statusText(page) {
  return (await page.locator('#status').innerText()).trim();
}

// 走完基本信息与送检条件两步，返回门户展示的提交前摘要，由调用方核对。
export async function fillToSummary(page, url, content) {
  await page.goto(url);
  await page.getByLabel('交接业务键').fill(content.requestKey);
  await page.getByLabel('材料编号').fill(content.material);
  // 切换样本类型会清空数量、联系人和介质并回到第一步，因此先选定类型再填后续字段。
  await page.getByLabel('样本类型').selectOption(content.kind);
  await page.getByRole('button', { name: '下一步' }).click();
  if (!(await page.locator('#step2').isVisible())) {
    throw new ValidationRejection(`基本信息未通过校验（${await statusText(page)}）`);
  }
  await page.getByLabel('样品数量').fill(String(content.count));
  await page.getByLabel('联系人').fill(content.contact);
  if (content.kind === 'leaf') {
    // 保存介质由当前站点配置动态出现，不假设它一定存在。
    if (!(await page.locator('#solvent-row').isVisible())) {
      throw new PageStateError('站点配置要求保存介质，但页面未出现该字段');
    }
    await page.getByLabel('保存介质').fill(content.solvent);
  }
  await page.getByRole('button', { name: '核对摘要' }).click();
  if (!(await page.locator('#step3').isVisible())) {
    throw new ValidationRejection(`送检条件未通过校验（${await statusText(page)}）`);
  }
  return JSON.parse(await page.locator('#summary').innerText());
}

// 点击确认提交。crashAfterSend 仅用于崩溃演练：等门户处理完这次提交
// （响应完成或连接被毁）后返回，由调用方注入崩溃，保证崩溃时服务端状态确定。
export async function clickCommit(page, { crashAfterSend = false } = {}) {
  if (!crashAfterSend) {
    await page.getByRole('button', { name: '确认提交' }).click();
    return;
  }
  const predicate = request => request.url().includes('/portal/submit');
  const settled = Promise.race([
    page.waitForEvent('requestfinished', { predicate }).then(() => {}),
    page.waitForEvent('requestfailed', { predicate }).then(() => {}),
  ]);
  settled.catch(() => {});
  await page.getByRole('button', { name: '确认提交' }).click();
  await settled;
}

// 等待提交结果：回执出现，或页面提示结果不明（网络错误、超时都算结果不明）。
export async function awaitOutcome(page, timeoutMs = 15000) {
  const receiptShown = page.locator('#receipt').filter({ hasText: 'receiptId' })
    .waitFor({ state: 'visible' }).then(() => 'receipt');
  const uncertainShown = page.locator('#status').filter({ hasText: '提交结果不明' })
    .waitFor({ state: 'visible' }).then(() => 'uncertain');
  receiptShown.catch(() => {});
  uncertainShown.catch(() => {});
  let timer;
  const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve('uncertain'), timeoutMs); });
  const outcome = await Promise.race([receiptShown, uncertainShown, timedOut]);
  clearTimeout(timer);
  if (outcome !== 'receipt') return { outcome: 'uncertain' };
  return { outcome: 'receipt', receipt: JSON.parse(await page.locator('#receipt').innerText()) };
}

// 通过查询页面按业务键取回全部受理记录。每次重新打开页面，避免读到上一次查询的残留渲染。
export async function queryByKey(page, url, requestKey) {
  await page.goto(url);
  await page.getByLabel('查询业务键').fill(requestKey);
  await page.getByRole('button', { name: '查询登记' }).click();
  await page.locator('#matches').filter({ hasText: '查询记录数' }).waitFor();
  const blocks = await page.locator('#matches pre').allInnerTexts();
  return blocks.map(text => JSON.parse(text));
}
