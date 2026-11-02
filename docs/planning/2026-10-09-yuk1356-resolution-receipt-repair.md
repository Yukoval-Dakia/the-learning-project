# YUK-1356 native resolution receipt 修复

实施基线为 `5f09c7bdc9837988a67a5b37209835bf6e1fe50d`，branch 为
`feat/yuk-1356-durable-judge`。进入时工作树与暂存区均为空；已封存 1574 个父级
文档的原内容。实施期间父级提交了 `8714bc8e8ffd835034e5dc1be4f7023e40b9ae43`，
仅更新 PLAN、now、父验收报告及新增首轮 DB 失败证据 JSON，产品源码未变。
本 writer 保留该父级提交，只修改 durable-attempt、现有 native DB fixture 和本文。

父级实际首失败保存在 `/tmp/yuk1356-parent-db/db.log`，其副本为
`/tmp/yuk1356-resolution-repair/parent-first-db-failure.log`，SHA256 为
`16bce913bda5f40b4c4d3db25d7dda3e5dde7987c4478b4d375d071bc47c611e`。
`judge_run.db.test.ts:62` 仍严格要求 resolution event 数量为 1；该测试文件逐字节未变，
SHA256 为 `af548c013ffcc835bfb3841f1a2711052da50d297a7e8278caa3aa91b987f534`。
本轮未重跑父级 DB、runtime 或任何进程验收，未获取运行锁。

根因与合同：`commitFormalAttempt` 的 callback 位于 native activation/settlement
之后。`readJudgeRunPermanent` 在没有 run-id event 时可从 exact native completion
重建 resolved，这是正确的只读恢复用途。旧 writeResolution 将该状态误当成具体回执
已经写入。`writeEvent` 使用 event ID 的 `onConflictDoNothing`，重复 ID 返回原 ID，
因此仅检查 candidate 或 writeEvent 返回值不能证明原回执一致。

现在既有 writeResolution 在 runR 下先读取实际 run-id event。已有回执须通过
NativeJudgeResolutionPayload parse，并与预期完整 payload 的 canonical hash、
session、actor、action、question、outcome、causal anchor、task/cost identity 一致；
冲突抛出 coordinate_mismatch，不覆盖原行。插入之后重新读取并验证，防止重复 ID 的
first-write-wins 被误当成成功写入。

回执缺席时继续复用原 selector。只有 effective completion 的 submission/group、
candidate、original 和 effective evaluation 都属于本次候选时才允许补写，避免 native
完成导致 requireJudgeRunOpen 返回 closed。其余路径仍调用原 open-run fence。
accepted expected_head 构造不可变 activation_intent，head 前进不改变回执的 CAS 坐标；
final_rating 仍优先保留用户覆盖。正常 callback 在 activation 的同一个 Tx 写回执，
既有 commit 后 Tx 可补齐缺回执，不重新执行 capture、activation、settlement 或模型。
selector、kernel、队列入口、SSE 与恢复循环均未修改，也没有新增消费者。

新增 19 个 DB 回归场景，全部为 **prepared DB UNRUN**：

- 同 Tx 写回执及独立连接提交可见性，用户评级保留，重投无重复效果。
- resolution COMMIT acknowledgement 丢失后，原回执与学习效果不变。
- native 已提交而回执缺席，补写使用 accepted CAS，原件和生效映射一致。
- 13 种已提交同 ID 冲突，覆盖评级、判词、status、candidate、submission/group、
  activation intent、attempt/causal anchor、actor、question、session 与 action。
- writeEvent 返回相同 ID 的冲突使 native activation/settlement 回滚；sealed candidate
  保留，后续执行不重买模型。
- 新 manual effective candidate 不可用来补原回执；manual disposition 赢得 held
  resolution 前的竞态时，原 open-run fence 继续阻止写入。

现有 held 后 self-report 测试另增加原回执整行不变断言。fixture 的 nativeEffects 对比
包含原事件、submission、evaluation、head、FSRS 和 mastery；模型与 queue IO 离线，
实际业务 DB 操作留给父级。没有以 mock 结果宣称 DB 或实际模型输出验收。

允许的检查在 Node `v24.19.0`、pnpm `11.13.1` 下完成：两个 scoped unit 文件
41/41 PASS，typecheck PASS，lint PASS（287 warnings），完整 build PASS。
unit 只验证沿用的 evaluation projection/status 合同，不是本修复的 DB 证明。
首次 typecheck 的 fixture unknown payload spread 导致 TS2698，已改成 schema parse；
原失败日志保留为 typecheck-first.log。该首次命令的 Homebrew Node 24 路径不存在，
实际使用 Node 26.10.0；后续成功检查均使用已核实的 mise Node 24 路径。

完整命令、时间、退出码和日志 SHA 见 `/tmp/yuk1356-resolution-repair/commands.jsonl`。
build 的 web/Start/server/worker/migrate 产物共 884 文件，已复制到 build-artifacts，
manifest 为 build-artifacts.json，其 SHA256 为
`b27a04c86c796d84b83253bbb0c0c58d25a912433480b3488e5e82a5899d577c`。
这只是产物封存，未执行这些产物。源码输入、原失败 fixture 与父文档快照也在同目录。
精确交付 commit、源码 diff 和全部证据入口由 HANDOFF.md 记录。

独立 R1 固定读取 5f09，仍由父级负责裁决；本交付不代表 R1 resolved。
DB、migration、实际进程、provider、最终产物 logger 证明与后续交付仍由父级验收。
未执行 full test、Docker、DB、provider、browser、安装、锁、PR、push、Linear、
切 branch 或 merge。已验证根因属于父级已捕获的 YUK-1356，同轮未发现新的独立
actionable follow-up；遵守父级独占 tracker 和 PLAN/now/验收文档的边界。
