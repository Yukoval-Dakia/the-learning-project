# YUK-1047 — 发布证据纠偏与入口迁移跟进

原 D1–D19 已批准范围内的验收修复；不是新评分系统或生产切换授权。

## 已验证缺口

基线 main d8e57a80。`evaluation-authority.ts` 的八入口登记和七个实际调用点
（solo/durable 共用 submit）都仍走 legacy，旧 invoker 分支仍执行。
`buildAssertions` 却仅凭 active epoch 报 no-runtime-fallback ok；先修改这一语义断言，
16项基线中1项 RED、15项 PASS（`/tmp/yuk1047-manifest-red.log`）。
八入口迁移原验收并未交付，已重新打开原 YUK-1047，不新建重复项。

## 本批交付

- CLI 有界 AST 扫描 src 下生产 TS/TSX 的 evaluateAttempt 调用，采集实际 entry 与
  legacy/contract 属性；支持具名导入别名、namespace 调用、条件入口。
- 独立八入口验收清单与实际调用对账，不信任 runtime registry 的 lane 标签。
  动态/间接引用、顶层 spread、重复属性、双 lane、未知 entry 显式 unresolved。
- 附相关源文件 SHA-256、位置、旧执行器调用、缺失入口。只证明当前检出源码，
  不是完整调用图分析或部署镜像身份证明；不会把扫描未发现当成 runtime ok。
- 旧调用或旧执行器存在即 fail。无源码/未知/缺入口/仅 contract 语法都只 info，
  仍需部署镜像与完整冻结链验收证据。数据库 epoch 保留独立判断。
- 离线及 DB 不可达也保留源码 fail，写出工件并 exit1；不读取默认 DATABASE_URL。
  未改变任何数据库查询、运行时评分、UI 或 schema。

## 验证与后续

30 scoped unit PASS；typecheck/lint299/build PASS。两个真实 CLI 探针（离线与不可达
127.0.0.1:1）均输出8legacy/1executor/0unresolved并按预期exit1。
本地10audits全部通过；新工作树API生成器依赖链接补齐后通过，无源码生成差异。
独立冻结初审30unit及两个CLI场景通过，8个源文件摘要逐一匹配，无P0/P1或实质P2。
待exact-head CI与最后push后17分钟窗完成才合并。

本批不能关闭 YUK-1047。继续冻结发题→草稿恢复→提交→评估→激活→读面全链迁移，
保留原付费claim、幂等/once-only、FSRS物理targets和零确认答案丢失。
联合路径的多submission模型继续 YUK-1091；不可提交时捏造latest revision。
YUK-1120已修复契约路径范围，不能据此声称正式八入口已使用契约。
历史生产记录保留，没有重新查询/部署生产；没有付费模型调用。
