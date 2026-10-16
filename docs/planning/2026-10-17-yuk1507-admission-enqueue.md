# 第一天能用：待准入题目的自动入队与付费恢复

服务契约：ADR-0073、YUK-1507 LIGHT、YUK-1445 C1；审计根 YUK-1388。

## 范围与合并边界

本片只修改 practice manifest 的新 subscriber 与现有 question_admission_run 条目、该 job，以及 admission 下 enqueue/receipt。无 DDL，复用已纳入备份恢复的 paid_effect/control。注册器、worker、publisher、source_verify、模型路由不改。

与主线 LIGHT PR 同一窗口合并：本片先、LIGHT 后；两者一起交付，不单独部署。LIGHT 将来源核验成功改为 withheld/unverified_rules，并补 admitted 的独立核验门。本片不能替代这个生产者修复。

## 触发与锁

experimental:assessment_publish 是既有事务 event outbox。新 subscriber 的既有 bootstrap 跳过当时快照内的历史事件，不扫描存量，不自动回填 52 题。

订阅处理锁序为 paid-effect family → question root → lifecycle。事务内重读当前 revision、withheld/unverified_rules、未撤回/未挂起，再通过同一个 Drizzle 事务发送 pg-boss job。job ID 来自 group/revision/digest/admission generation，payload 额外冻结 admission generation 与 backend generation。同一 generation 的事件重投不会产生第二个 job；临时 hold 后重新 pending 的新 generation 可以入新 job，仍复用同一付费批，不被旧终态队列行堵住。C1 自己的发布事件跳过；来源核验 passed 的发布事件不跳过，因为来源核验不等于解题准入。

worker 在 family 锁内校验原 pg-boss delivery 仍 active 且 payload 相等，再取 root/lifecycle 锁、复核版本和准入状态、写 claim。不持数据库事务等待模型。

## 谁最多付费一次

同 group/base-contract digest 的整批准入只允许首次 claim 获胜者执行一次 C1（双解及必要的来源答案交叉核验）。该批有自己的 immutable input，包含原 revision/digest/generation、四层 contract、科目 profile、policy 和 solver2 配置。恢复优先按原 delivery/revision 找批，再按 base digest 找；环境配置变化不能创建另一条付费身份。

历史相同 base digest 的 C1 passed、failed、suspended 都短路。sending/unknown 保留跨 revision 围栏，不因 queue retry、lease 到期、重投或重启重付。现有 runner 路径保留，显式 judgeRetryPolicy=none 关闭 runner 和 Pi SDK 自动请求重试；其 timeout/rate/cost 约束保持。**这不是正常 chat 路径金额硬上限的验证证明。** 本次不调用 provider，不申请或消费预算。

## 收据、应用与未知结果

完整 admitted/withheld 结果先在独立事务写入不可变 result receipt（包含 resolved contract、逐单元校准和 task-run/provider/model/cost 证据）。再用单一事务重新锁定并核对输入、版本和 generation，调用既有 publisher，与 application receipt 一起提交。

- 收据已落但发布失败：只从已封存结果重试发布，不再 solve。
- 发布成功但队列未确认：application receipt 短路。
- 内容或 revision 真变化：保留 paid receipt，记录 stale application，不把旧结果升级到新题，重放如实返回 stale。
- 仅 availability/generation 变化：当前仍 pending 时在锁内用当前 generation 做 publisher CAS，不作废有效收据。临时 hold/撤回/其他准入决定：保持 receipt_ready，等待再次 pending 后只重放发布，不重新 solve。
- pending、调用结果未封存或崩溃发生在完整收据之前：保留 unknown/未决义务，不伪造成功或零成本；需要对账，不自动重跑整批。
- 到期 sending 在下一次本 family job 进入时归类为 unknown。没有新增 cron 或后台自动修复器。

完整收据前的局部结果目前无法从 ai_task_runs 的摘要还原。这意味着一次失败可能阻塞同题后续 revision，直到人工对账；安全性不等于自动恢复能力。原调用若仍存活，可由同 delivery/fence 写入真实晚到结果。

## 验证状态与待批准方案

源码类型检查、lint、build、capability 边界和 task census audit 已通过；独立初审进行中，远端 exact-head CI 待 PR。未写或修改测试，未运行 DB/runtime/provider，不能称自动准入已验收。

待 owner 批准的文本测试方案（当前 NOT_RUN，未写代码）：

1. 真实 event-subscription/job/PG 边界：已提交的当前 pending 发布只入队一次，历史 bootstrap 与 stale/hold 发布不产生付费工作；事务回滚不留下半个入队效果。
2. 真实 PG 并发 claim：两个 delivery 只有一条持久获胜 claim；相同 digest 的 failed/suspended、跨 revision unknown 不获得第二条 claim。验证状态，不断言 mock 调用次数。
3. job 恢复：完整 result receipt 后注入应用事务失败，重投从冻结结果完成真实 publisher + application receipt，原 provider/model/cost attribution 不变；新输入不能污染恢复。
4. job 与 publisher 交错：付费后编辑/撤回/owner hold，不发布旧准入；原结果和未决/失效处置保持可读。

真实模型验收、金额预算核对和 TEST 发布另经协调授权；源码/CI 结果不能代替它们。

## 本地证据

已正常合入 main e8eb9fe9f（含 #1737 展示层）；冻结 presentation 随输入保留，发布 resolved contract 时沿用该层并重算完整 digest。

- `/tmp/yuk1507-typecheck-04.log`：exit 0。
- `/tmp/yuk1507-lint-02.log`：exit 0，现有 176 warnings；最后仅将 retry 配置移入绑定 runner，局部 Biome 通过。
- `/tmp/yuk1507-build-03.log`：exit 0。
- `/tmp/yuk1507-boundaries-02.log`：exit 0，baseline 未抬升。
- `/tmp/yuk1507-task-census-02.log`：exit 0，56 kinds；首次动态包装调用的 census 失败保留在 `-01.log`，未修改 audit。

初版 typecheck 的 nullable revision_id 错误保留在 `/tmp/yuk1507-typecheck-01.log`，已修复；以上不构成 DB、runtime 或 provider PASS。

## 独立 R1 与修复

GLM 5.3 max 对 4ff3741b8 报两个 P1，父核真实 pg-boss INSERT 冲突与 publisher generation 路径后接受：

1. 队列稳定 ID 缺 generation 会让 stale/completed 旧任务吞掉解除 hold 后的新入队；现加入 admission generation，并对 send=null 如实报告已存在。
2. 应用时冻结 generation 比较会永久弃用仍有效的已付费收据；现只以内容/revision 判断真 stale，临时生命周期阻挡保留 receipt_ready，锁后当前 generation 用于 CAS。已终态 stale/conflict 不再谎称 already_verified。

唯一 R2 在固定修复版本上进行；没有第三审。DB4 首次 152PASS/4FAIL 是既有订阅备份 fixture 的五订阅清单与逐个 bootstrap 假设，文本修复方案已交 owner 审批，测试文件尚未修改。原日志 `/tmp/yuk1507-pr1752-db4-first.log` 保留；汇总 Gate 仅 DB lane 失败，其余 lane 成功。
