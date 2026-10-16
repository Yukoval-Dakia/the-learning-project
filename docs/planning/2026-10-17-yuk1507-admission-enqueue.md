# 第一天能用：待准入题目的自动入队与付费恢复

服务契约：ADR-0073、YUK-1507 LIGHT、YUK-1445 C1；审计根 YUK-1388。

## 范围与合并边界

本片只修改 practice manifest 的新 subscriber 与现有 question_admission_run 条目、该 job，以及 admission 下 enqueue/receipt。无 DDL，复用已纳入备份恢复的 paid_effect/control。注册器、worker、publisher、source_verify、模型路由不改。

与主线 LIGHT PR 同一窗口合并：本片先、LIGHT 后；两者一起交付，不单独部署。LIGHT 将来源核验成功改为 withheld/unverified_rules，并补 admitted 的独立核验门。本片不能替代这个生产者修复。

## 触发与锁

experimental:assessment_publish 是既有事务 event outbox。新 subscriber 的既有 bootstrap 跳过当时快照内的历史事件，不扫描存量，不自动回填 52 题。

订阅处理锁序为 paid-effect family → question root → lifecycle。事务内重读当前 revision、withheld/unverified_rules、未撤回/未挂起，再通过同一个 Drizzle 事务发送 pg-boss job。job ID 来自 group/revision/digest，payload 额外冻结 admission generation 与 backend generation。重投同一发布事件不会产生第二个 job。C1 自己的发布事件跳过；来源核验 passed 的发布事件不跳过，因为来源核验不等于解题准入。

worker 在 family 锁内校验原 pg-boss delivery 仍 active 且 payload 相等，再取 root/lifecycle 锁、复核版本和准入状态、写 claim。不持数据库事务等待模型。

## 谁最多付费一次

同 group/base-contract digest 的整批准入只允许首次 claim 获胜者执行一次 C1（双解及必要的来源答案交叉核验）。该批有自己的 immutable input，包含原 revision/digest/generation、四层 contract、科目 profile、policy 和 solver2 配置。恢复优先按原 delivery/revision 找批，再按 base digest 找；环境配置变化不能创建另一条付费身份。

历史相同 base digest 的 C1 passed、failed、suspended 都短路。sending/unknown 保留跨 revision 围栏，不因 queue retry、lease 到期、重投或重启重付。现有 runner 路径保留，显式 judgeRetryPolicy=none 关闭 runner 和 Pi SDK 自动请求重试；其 timeout/rate/cost 约束保持。**这不是正常 chat 路径金额硬上限的验证证明。** 本次不调用 provider，不申请或消费预算。

## 收据、应用与未知结果

完整 admitted/withheld 结果先在独立事务写入不可变 result receipt（包含 resolved contract、逐单元校准和 task-run/provider/model/cost 证据）。再用单一事务重新锁定并核对输入、版本和 generation，调用既有 publisher，与 application receipt 一起提交。

- 收据已落但发布失败：只从已封存结果重试发布，不再 solve。
- 发布成功但队列未确认：application receipt 短路。
- 版本或准入决定变化：保留 paid receipt，记录 stale application，不把旧结果升级到新题。
- pending、调用结果未封存或崩溃发生在完整收据之前：保留 unknown/未决义务，不伪造成功或零成本；需要对账，不自动重跑整批。
- 到期 sending 在下一次本 family job 进入时归类为 unknown。没有新增 cron 或后台自动修复器。

完整收据前的局部结果目前无法从 ai_task_runs 的摘要还原。这意味着一次失败可能阻塞同题后续 revision，直到人工对账；安全性不等于自动恢复能力。原调用若仍存活，可由同 delivery/fence 写入真实晚到结果。

## 验证状态与待批准方案

源码类型检查、lint 和 capability 边界 audit 已通过；build/独立初审/远端 exact-head CI 按本片固定版本记录。未写或修改测试，未运行 DB/runtime/provider，不能称自动准入已验收。

待 owner 批准的文本测试方案（当前 NOT_RUN，未写代码）：

1. 真实 event-subscription/job/PG 边界：已提交的当前 pending 发布只入队一次，历史 bootstrap 与 stale/hold 发布不产生付费工作；事务回滚不留下半个入队效果。
2. 真实 PG 并发 claim：两个 delivery 只有一条持久获胜 claim；相同 digest 的 failed/suspended、跨 revision unknown 不获得第二条 claim。验证状态，不断言 mock 调用次数。
3. job 恢复：完整 result receipt 后注入应用事务失败，重投从冻结结果完成真实 publisher + application receipt，原 provider/model/cost attribution 不变；新输入不能污染恢复。
4. job 与 publisher 交错：付费后编辑/撤回/owner hold，不发布旧准入；原结果和未决/失效处置保持可读。

真实模型验收、金额预算核对和 TEST 发布另经协调授权；源码/CI 结果不能代替它们。
