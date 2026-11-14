# sample-intake-operator

样品登记与查询门户，支持动态分步录入及受理回执。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。
准备浏览器环境时执行 `npx playwright install chromium`，或复用已安装且版本相符的 Chromium。运行阶段不下载浏览器。
浏览器页面回归：`npm run test:browser`。

Linux 门户健康检查使用单独的 Python Playwright 绑定，版本及传递依赖见 `requirements-verification.txt`；产品仍为 Node.js。先向检查器的 Python 虚拟环境安装该清单，再用 `python3 -m playwright install chromium` 准备匹配的浏览器。npm 的 Playwright 安装不能替代 Python 绑定。项目环境准备工具可一次完成清单安装和浏览器准备；日常启动与回归须在预装环境中离线运行。

```bash
npm run build
npm test
npm run demo
npm start
```

交接清单一键采集（从临时交接清单到 intake-receipts.json）：

```bash
npm run intake -- --handover data/handover.json --out intake-receipts.json
```

未指定 `--url` 时自动启动本地合成门户并在结束后关闭；指定 `--url` 时连接已在运行的门户（`npm start` 启动的实例），用于跨重启恢复演练。`--state-dir` 指定执行记录目录，连接外部门户时默认 `var/intake-state`，临时门户模式使用全新临时目录。退出码：0 全部受理；6 有暂停；7 有失败；2 为演练注入的崩溃。暂停与失败会在汇总中逐条显式列出。

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

浏览器依次访问登记表单的基本信息、送检条件和核对摘要。seed 不需要 solvent；leaf 需要保存介质，类型切换会清掉数量、联系人和介质。count 为 1 至 20 的整数，业务键和材料编号去首尾空白，材料编号统一大写；contact、solvent 去首尾空白。表单及查询页面为 RPA 的唯一业务入口，不能直接 POST 内部接口。

POST /_control {"lostResponseOnce":true} 让下一次最终提交在服务端成功后断开连接。records 可以注入已有登记（receiptId、content）以演练多条和冲突；该操作仅用于演练准备。查询按业务键给出全部受理记录，不保证唯一，也不提供服务端幂等提交。服务保持运行时登记数据不因浏览器或采集端重启消失。

intake-receipts.json 包含 items：requestKey、status（accepted/review/failed）、contentHash；accepted 含 receiptId，review/failed 含 reason。不保存联系人明文，完整业务输入来自 data/handover.json 或操作员指定路径，输出日志应最小化。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

## 采集端（RPA）

采集端只通过浏览器操作登记、查询与回执页面，不直接 POST 内部接口。每条交接资料在 `--state-dir` 下留有独立执行记录（阶段、内容哈希、尝试次数、受理号或暂停原因），先写临时文件再改名，崩溃不会留下半份记录；记录不含联系人明文。

执行规则：先按业务键查询，确认不存在才走分步表单；类型切换会清空后续字段，采集端先选定类型再填写；保存介质等条件字段按当前站点配置动态出现；提交前核对页面摘要与规范化业务输入一致；点击确认提交前持久化“结果未知”状态。提交后无论看到回执还是结果不明，都通过查询页核对整份规范化内容：唯一且完全一致才认领回执，不存在可重新登记（同一资料最多点击两次），内容不一致或查到多条则暂停交人工，不猜测受理号、不重复点提交。演练发现：服务端成功后断连时浏览器会自动重放提交，同一份样品可能因此占了两个受理号——页面显示的回执不代表唯一，必须经查询页确认。

恢复不依赖内存进度：崩溃在点击前、点击后或收到回执未落账时，重新执行同一命令即可按执行记录与门户查询继续。人工处置后删除对应 `state-<业务键>.json` 再重跑。`INTAKE_CRASH_AT=before-submit|after-submit|after-receipt` 仅用于崩溃恢复演练。浏览器回归覆盖条件字段、校验拒绝、提交结果不明、多记录冲突及上述崩溃点，见 `browser/intake.test.mjs`。

## 数据校验

`npm run verify -- intake-receipts.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
