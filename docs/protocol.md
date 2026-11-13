浏览器依次访问登记表单的基本信息、送检条件和核对摘要。seed 不需要 solvent；leaf 需要保存介质，类型切换会清掉数量、联系人和介质。count 为 1 至 20 的整数，业务键和材料编号去首尾空白，材料编号统一大写；contact、solvent 去首尾空白。表单及查询页面为 RPA 的唯一业务入口，不能直接 POST 内部接口。

POST /_control {"lostResponseOnce":true} 让下一次最终提交在服务端成功后断开连接。records 可以注入已有登记（receiptId、content）以演练多条和冲突；该操作仅用于演练准备。查询按业务键给出全部受理记录，不保证唯一，也不提供服务端幂等提交。服务保持运行时登记数据不因浏览器或采集端重启消失。

intake-receipts.json 包含 items：requestKey、status（accepted/review/failed）、contentHash；accepted 含 receiptId，review/failed 含 reason。不保存联系人明文，完整业务输入来自 data/handover.json 或操作员指定路径，输出日志应最小化。
