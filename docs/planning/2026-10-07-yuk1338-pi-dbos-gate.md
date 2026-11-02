# YUK-1338：Pi + DBOS 隔离恢复 gate

日期：2026-10-07。所属 epic：YUK-1351。依据：ADR-0066、ADR-0065、准备计划 §4/§5/§8/§9。按 owner 自主交付委托实施，非 UI；本线程不合并、不部署。

## 范围和决定

用真实 Pi 1.0.2 循环、DBOS 5.2.11、PostgreSQL 和真实子进程验证恢复与版本契约。只有模型响应由可控替身生成，场景为椭圆题作答：带教师提示的局部理解需要支持式复习，新独立正确证据改为迁移练习。长作答、分题观察、帮助程度、含糊解释与边界情况保留在 fixture；该策略不代表真实模型的学习判断质量。

`@dbos-inc/dbos-sdk` 固定为 **5.2.11 devDependency**，只用于 gate。Pi 维持已有 **1.0.2**，未升级生产 SDK。lockfile 新增 DBOS 及其传递依赖；pnpm 同时规范化了已有 optional peer 的 snapshot 标识，没有升级已有包版本。

生产组合根、API inventory、Hono/Vite/pg-boss worker、应用迁移和前端均未修改。测试 manifest 只由测试组合根消费，不导出给 `src/capabilities/index.ts`。测试使用既有 scoped DB 配置新建的 Testcontainers PostgreSQL；worker 只接受 loopback `test_fork_<n>` 和显式测试标志。子进程环境只传 PATH、NODE_ENV 与本 gate 的测试参数，不继承生产 URL、token 或 provider 配置。没有生产数据、付费调用或部署。

## 模块和恢复所有权

| 模块 | 责任 |
| --- | --- |
| `src/capabilities/practice/testing/pi-dbos-gate/operations.ts` | 原始证据、状态版本、`arrangeNext` 提交校验、事务效果与不可覆盖的幂等回执；仅供 gate |
| 同目录 `manifest.ts` | 隔离页面命令路由，由真实 `buildHonoApp` 挂载并执行现有 token middleware |
| `tests/pi-dbos-gate/workflow.ts` | DBOS workflow；Pi 的模型响应、业务提交和工具回执分别为步骤，工具按顺序执行 |
| `tests/pi-dbos-gate/worker.ts` | 独立 Node 进程、DBOS launch/recovery、故障注入 IPC；恢复模式不调用 startWorkflow |
| `tests/pi-dbos-gate/recovery.db.test.ts` | 真实数据库、SIGKILL、不同 PID 重启、DBOS 步骤与领域效果断言 |
| `tests/pi-dbos-gate/fixture.ts` / `contract.unit.test.ts` | 复杂合成证据与输入边界；没有模型质量准入含义 |

领域表在 `yuk1338`，DBOS 系统表在独立 `yuk1338_dbos` schema。只由 DBOS 恢复 gate workflow。事务回执用于识别已提交效果，不调度、不启动工作；观察表 `model_attempt` 只记录替身调用，从不作为恢复输入。没有 pg-boss、Pi Durable、outbox scanner 或额外 reconcile 同时恢复该循环。

```text
页面命令 ────────────────────────────────┐
后台 DBOS step ──────────────────────────┼─ arrangeNext → learner lock → prior receipt
Pi tool → DBOS business-commit step ──────┘               → version/expiry check
                                                        → effect + receipt transaction
Pi streamFn → DBOS model-response step → saved response → reconstructed Pi stream
Pi tool     → business-commit step → separate tool-receipt step → Pi tool result
```

整个 Pi 循环是 workflow 内的控制流，未包成一个可重试步骤。DBOS 重放已保存的 snapshot 和完整模型响应，重建 Pi 流后依次进入工具步骤；稳定操作身份为 `workflowId:toolCallId`。领域回执将身份绑定到命令 digest；同身份不同参数报错。新证据清空旧安排并推进版本，成功安排也推进版本，因此两个旧版本提案只能有一个提交。取消框架与真实 provider 的恢复策略不在本 gate 中，不把取消称作已提交效果的回滚。

Pi 自身生成的消息时间戳只用于 transcript，不决定步骤顺序；workflow 的 prompt 时间与有效期来自持久输入，读取状态、数据库时间、模型响应及效果均在 DBOS step 中。恢复必须使用同一份源码；`applicationVersion` 是 gate 源码与依赖清单 digest，不支持跨代码版本盲目恢复。

## 验收与故障矩阵

| 条件 | 可执行证据 |
| --- | --- |
| 新证据影响下一项 | 两次真实 Pi workflow：提示作答 v1 → 支持式安排 v2；独立作答 v3 → 迁移安排 v4。回执记录数据库时间与输入版本，另记录提交确认到效果可读的观测延迟 |
| 旧结果不覆盖新状态 | 模型响应保存后推进证据版本，杀 worker 再恢复；旧工具提交返回 `stale-version`、效果 0；新 workflow 使用新版本成功 |
| 已保存响应复用 | 模型响应检查点后 SIGKILL；重启从 PENDING 自动恢复，第一轮替身调用仍只有一次，步骤输出与观察到的完整响应相等 |
| 工具提交后的回执丢失 | 领域事务提交后、DBOS commit step 返回前 SIGKILL；恢复再次调用业务操作，从领域回执返回，效果恰好一条 |
| 工具回执已保存 | receipt step 返回后、Pi 收到结果前 SIGKILL；重放不重付效果，Pi 完成下一轮 |
| 未知外部窗口 | 替身已响应、DBOS 未保存 response step 时 SIGKILL；恢复产生第二次替身调用，明确记录 unknown outcome |
| 过期和锁竞争 | 保存响应后等待有效期结束再杀进程恢复，拒绝 `expired`；另用真实行锁阻塞提交至过期，锁取得后才取数据库时间，拒绝且状态不变 |
| 三入口共用操作 | 页面经测试 manifest 与现有 Hono token middleware；Pi execute 与后台 DBOS step 都调用同一 `arrangeNext`。缺/错 token 401、效果 0；有效命令、相同身份重放与不同 payload 冲突均核验 |
| 并发和原始证据身份 | 两个同版本命令竞争，只有一个效果；重复证据不推进版本，同证据身份不同内容拒绝 |

每个正常恢复场景先查 DBOS PENDING 和崩溃前效果，再验证 SIGKILL exit signal、新 PID、recoveryAttempts、SUCCESS、步骤清单与数据库计数。完成后再次以同 workflow ID 启动也不新增模型请求或业务效果。

锁竞争测试首次复现了 gate 草稿中的错误：`SELECT clock_timestamp(), ... FOR UPDATE` 的投影时间早于锁释放，返回 accepted。已改为取得锁、检查既有回执后再单独读取 `clock_timestamp()`；同一场景须返回 expired。这是本 PR 内已修缺陷，不留下未实施 TODO。

## 命令和证据封存

```bash
pnpm vitest run --config vitest.unit.config.ts tests/pi-dbos-gate/contract.unit.test.ts
TLP_GATE_EVIDENCE_PATH=.cache/yuk1338/evidence.json pnpm vitest run --config vitest.db.config.ts tests/pi-dbos-gate/recovery.db.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

不运行完整本机 `pnpm test`。DB 测试 setup 自带测试容器迁移，不使用生产迁移入口。原始合成输入、模型响应、工具回执、PID/信号、步骤与 input/output digest 封存在相邻 evidence JSON。`sourceHashes` 是各文件原始字节的 SHA-256，`codeDigest = SHA256(JSON.stringify(sourceHashes))`；测试输入/输出 digest 使用 SHA-256(JSON.stringify(value))。记录归属以同 PR 的源码 commit 和这些文件 hash 为准，文档提交不会改变 gate 的代码版本。

main 的 PR #1580/#1589 已正常合入本分支，锁文件冲突按两边依赖合集解决，`pnpm install --frozen-lockfile` 通过；没有升级 main 既有依赖版本。合并后重新执行上述全部 scoped/static/build gate，10 DB 场景耗时 33.40 秒。

验证源码固定为 `a3078179ad0c7ea8e713060a5e896225466c57b0`；每个 `sourceHashes` 均已与该提交的 git blob 逐项核对。PR [#1590](https://github.com/Yukoval-Dakia/the-learning-project/pull/1590) 已登记 T3，YUK-1338 为 In Review；旧 exact-head CI run 37612250074 因 lint 失败，修复 push 后的新结果交父线程核验。

## 结论与后续边界

本机 gate 的五项验收通过：scoped unit **2 passed**，scoped DB **10 passed**；typecheck、lint、build 均 exit 0。lint 是已有 **297 warnings**，没有提高基线或关闭规则；partition audit 没有未分区测试或 unmocked DB unit。T3 Codex / gpt-6.1-sol xhigh 已读取真实源码 diff 和封存证据，独立审查 **P0/P1 NONE**；没有运行测试或服务。exact-head CI 状态在 PR 交接中单独记录。该 gate 只决定能否继续评估 ADR-0066 的步骤级执行方案；不等于当前产品迁移、上线或真实模型准入。

封存结果见 [原始合成证据](2026-10-07-yuk1338-pi-dbos-gate.evidence.json)。两轮安排在输入 v1/v3 上分别生效为 v2/v4；提交确认至效果可读观测为约 **935 / 542 ms**。四个崩溃边界的最终效果均一条；未知模型窗口第一轮替身调用两次，其余保存后的第一轮响应只有一次调用。

独立审查保留一项 P2：`recordAnswer` 在 learner 尚不存在时不能锁住创建，两个同 learner/evidence 身份的首次并发提交可使第二个 evidence INSERT 返回 `23505`。不丢数据，不影响本 gate 的工具副作用恢复；当前 PR 不扩张修复该生产作答入口问题，也不把它称为已修。已归入现有 YUK-1356：生产化前序列化首次创建或复用现有事件幂等协议，并加入并发首次提交验收。

回执 `latencyMs` 是两次事务内部时间戳之间的差值，不是 WAL commit 瞬间的测量。`commitAckToEffectObservedMs` 使用测试父进程的单调时钟，从 `recordAnswer` 事务完成确认后到 workflow 完成且数据库效果可读；它包含进程启动、后续模型替身回合与完成观察开销，是本次观测上界，不能作为实时 SLO 或性能基准。

模型或外部工具已经执行、检查点未保存时，DBOS 不能保证 provider exactly-once 或零重复费用。本 gate 故意保留并观察这个窗口；迁移时须为真实 provider 保存稳定请求身份与未知结果处置，不能把这里自动重调可控替身的策略直接用于付费调用。

独立审查确认 Pi 的 transcript 时间戳在重新发起尚未保存的模型步骤时会变化，未知窗口里观察到 request digest 不同。本替身不以这些时间戳作选择，因此步骤顺序与已保存响应重放成立；真实 provider adapter 仍须固定请求信封/身份，不能把这份测试直接当作外部请求字节完全一致的证明。页面入口证据是带 token middleware 的 in-process Hono Request，不是浏览器体验或网络负载验收。

不新增需要删除的恢复机制。P4a/YUK-1356 迁移到生产域时须把该示例的版本/事务边界适配现有事件、FSRS、掌握度和 run logging，之后移除 gate 专用领域表/替身，不让它成为第二套学习状态真相源。P5/YUK-1355 按任务族保留现有 pg-boss 义务，切换后排空并退役对应旧 producer/handler/reconcile/cron；本 gate 不删除或排空现役机制。

SDK 依据：[DBOS workflow determinism](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)、[steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial)、[recovery](https://docs.dbos.dev/production/workflow-recovery)、[Pi 1.0.2 agent source](https://github.com/earendil-works/pi/tree/v1.0.2/packages/agent/src)。实际接受标准以本 PR 的数据库和进程证据为准。

## CI 修复与父线程交接

已实查 [run 37612250074](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/37612250074) 的 `typecheck · lint` 日志：Typecheck 成功，`Lint and warning ratchet` 失败。原树相同命令复现 **1 error / 297 warnings / 0 infos**；唯一 error 为最后封存的 evidence JSON 的 Biome format（短数组的排版），不是 TypeScript 或恢复契约错误。上次在证据末次落盘后漏跑 lint，旧 run 不能称为最终 gate 通过。

修复只规范化证据文件格式并更新本次实测数据/交接，没有修改 gate 源码、依赖、CI 配置、formatter 规则或 warning baseline。末次封存后执行 Biome format，再执行 lint 与 CI 同款 `node scripts/ci/lint-ratchet.mjs`；全部最终检查完成后才提交。失败日志 SHA256 与复现计数记录在 evidence JSON 的 `ciRepair`，五项验收仍映射到既有故障矩阵。

本次重新运行 **2 unit / 10 DB**（DB 场景 32.27 秒）、typecheck、lint、warning ratchet、build；10 个源码 hash 与 a3078179a 的 git blob 均一致。未知外部结果限制和原独立 review 结论不变，没有重复独立 review。CI 最终结论以新 push 的 exact-head run 为准；本机通过不能替代最终 CI。

57961995-70c3-4121-a9dd-97d90471be1a 父线程负责 PR watch、最终 merge 和迁移协调；本线程不 watch、不 merge、不接触 runtime、部署锁或旧未知候选。P0 最终通过后由父线程立即衔接 P1/P5，不把 YUK-1363/1364 的独立运维工作作为串行 gate。本次无新增产品缺陷或架构改变需要新 follow-up；原 YUK-1356 的生产化要求保留。
