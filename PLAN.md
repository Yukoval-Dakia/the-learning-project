# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-28（AI Pipeline Modernization F5 最终收口）

## NOW

- **F5 实施与收口已完成。** 根 Copilot 保持前台；只有
  `durable:true` 才明确请求 durable run。安全的 remote read/idempotent tool 超过 45 秒才交出
  `tool_operation` handle；write/propose、`run_task` 与未证明安全的外部工具继续阻塞。
- 已合并的 F5 PR：#1302 YUK-926 `f64f1389`、#1303 YUK-927 `c8f90778`、#1304 YUK-930
  `4c223bf5`、#1305 YUK-929 `e4e87b08`、#1306 YUK-928 `ad45e3e1`、#1307 YUK-931
  `d28061d0341432417a97edd9d57750a7fd93c773`、#1308 YUK-932
  `1cf06f575763fb72b558b6c8a2f064405a8a06bb`、#1309 YUK-933
  `82eddbdfcfec66b7c11fa2269ebe0886bc405a45`、#1310 YUK-934
  `2e815cd5b3879095a2474d85b2e66e2980bab901`。
- YUK-934 exact-head `CI Gate` run `33158219176` 在 head
  `a8759ebe1bf42d0c7beb4fc2115113f66b329e54` 通过 aggregate/static/unit/DB/migration/build/usability；
  独立 review 已完成，P1 修复验证后无剩余 P0/P1。task census 最终为 53 registered / 52 statically invoked /
  1 compatibility。
- 真实持久化边界：`copilot_run` / reconcile、`ToolOperations` 与 `SubagentRuns` 各自拥有生命周期；
  mailbox 的 one-shot continuation 只恢复同一根请求，用户面保持一个声音。drawer 只展示状态、结果、错误
  与操作，不展示执行架构术语。

## NEXT

1. 不自动继续、不部署；仅在取得单独授权后进行生产观察。
2. 其余工作仅限 owner 重新开启的 parked roadmap；本板同步即 parent YUK-927 closeout，不声称 parent
   Linear issue 已经 Done。

## PARKED

- 多 provider 方案一（YUK-921）、YUK-572 夜间教研 agent、YUK-832 HOLD 与 Architecture FULL 的生产观察均不属于 F5。
- 不新增 pg-boss job kind、child-process 或 code-cell handle：当前没有声明 owner 的真实 consumer。
- 本地脏 `main` 不清理、不覆盖；F5 只在外接卷隔离 worktree 中修改。

## BLOCKED-ON

- 生产部署与生产观察需单独授权；本次没有部署授权。
- 完整测试权威是 push 后的 exact-head GitHub `CI Gate`，本地 scoped 结果不替代它。
