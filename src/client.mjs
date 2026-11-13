export async function inspect(base) {
  const response = await fetch(base);
  return { status: response.status, title: /<title>(.*?)<\/title>/.exec(await response.text())?.[1],
    instructions: '使用浏览器登记，提交不明时先用页面查询业务键' };
}
