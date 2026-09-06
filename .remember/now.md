# 当前 handoff — 2026-09-06（完整重构goal active）

## Active：YUK962 测试分区收口

- 工作树 /Volumes/YukovalSBak/yukoval-projects/tlp-wt-pure-test-partition；
  branch codex/yuk-962-pure-test-partition，代码bf59af8d（base main db5a57b1）。
- 3 kernel测试原字节改名unit，2 server/ai纯逻辑测试加入fast；删3个不存在的旧include路径。
  5files/59tests在无DB环境通过；独立review PASS且DB收集零条；总1043测试文件不变。
  partition617unit/426DB（原612/431），无新增P0；剩余3传递DB候选和2 Bun插件测试不删除。
- typecheck/lint/build通过；下一步提交状态/PR/exact CI。详细证据见
  docs/planning/2026-09-06-pure-test-partition.md。没有新模型调用/生产变更。

## 并行交付及依赖

- YUK961 / tlp-wt-pool-gap-owner：Agency拥有pool-gap提示规则，Practice只提交已完成验证事实。
  exact69542b2d，root与独立review均48DB通过，typecheck/lint/build/audits通过。
  PR1340 / CI34032977403运行中，只有确切CI绿且无未裁决P0/P1后合并；不得重复启动验证。
- YUK944 Done：PR1338 exact3fd90c4d CI34030191329全绿，已合并main db5a57b1。
  原五读取actual核心通过；input40410 vs baseline40401，不称此复杂样本token下降。
- YUK945 / tlp-wt-native-compaction：代码18702ab9已修初审两P1、唯一复审PASS，root143tests。
  PR1339 exact821184ac CI34031520139全绿，仍draft；06d01dbc仅本地证据/状态补充未推。
  尚未真实模型摘要质量验收，不能关闭/合并。原生loopback同session compact/reinject/resume已验证。
  SDK窗口最低100000；更小值被忽略。人工usage不是实测节省，协议证据不是生产E2E。
- 944累计成本$1.31710818，剩余授权$0.28771982。945追加最多$1请求仍待owner答复；
  不新增付费调用。此前超时/child未知费用仍未知，不能填0。
- YUK949成品选择正在只读设计：删除reply-tail primary_view marker，同时保留三source与
  agent呈现意图；不按工具/effect盲猜。尚未实施；生产UI若改代码需设计预检批准。
- YUK960报告问句被题目检测误拦仍未修，需保留无标签真实题保护。

## 已交付与剩余范围

- Pipeline1326、Goal1327、Knowledge1328、Import1329、Copilot execution1330、
  ReviewSettlement1332、测试精简1331/1333、客户端状态1334/1336已各自验证合并。
  历史证据见docs/planning/2026-09-06-business-architecture-closeout.md及evidence。
- 946 Done为原生skill catalog→调用后body验证，不建第二目录，不删除quiz能力。
  943/947 Canceled为被锁定设计替代，不是伪称实现。
- 主线依赖438/0/47，五capability SCC/20命令消费者仍在；正常公共命令协作不等于规则多头维护。
  learning-intent已拥有单事务及owner失败全回滚，不为SCC计数再次重构。
- 整体945/948/949/950/960/961/962与跨业务验收继续，不能用当前PR替代完整goal。
- 原始the-learning-project脏main不动。不部署/切SoT/backfill/删除历史。
  887生产副本验证需独立授权；951退休需部署后零pending覆盖完整重试窗口；
  921多provider、572夜间教研、832HOLD均不解锁。
