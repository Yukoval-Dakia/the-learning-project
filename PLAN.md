# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-28（AI Pipeline Modernization F5 最终收口，main @ `82eddbdf`）

## NOW

- **F5 实施已完成，YUK-934 正在收口文档、审计与 API 描述。** 根 Copilot 保持前台；只有
  `durable:true` 才明确请求 durable run。安全的 remote read/idempotent tool 超过 45 秒才交出
  `tool_operation` handle；write/propose、`run_task` 与未证明安全的外部工具继续阻塞。
- 已合并的 F5 PR：#1302 YUK-926 `f64f1389`、#1303 YUK-927 `c8f90778`、#1304 YUK-930
  `4c223bf5`、#1305 YUK-929 `e4e87b08`、#1306 YUK-928 `ad45e3e1`、#1307 YUK-931
  `d28061d0341432417a97edd9d57750a7fd93c773`、#1308 YUK-932
  `1cf06f575763fb72b558b6c8a2f064405a8a06bb`、#1309 YUK-933
  `82eddbdfcfec66b7c11fa2269ebe0886bc405a45`。
- 真实持久化边界：`copilot_run` / reconcile、`ToolOperations` 与 `SubagentRuns` 各自拥有生命周期；
  mailbox 的 one-shot continuation 只恢复同一根请求，用户面保持一个声音。drawer 只展示状态、结果、错误
  与操作，不展示执行架构术语。

## NEXT

1. 完成 YUK-934 独立 review、push 后 exact-head GitHub `CI Gate` 与合并；本机只做与改动匹配的 scoped
   校验，绝不运行完整 `pnpm test` 或本地 gate。
2. 合并后同步 YUK-934 / parent YUK-927 的 Linear 状态，执行 closeout capture gate，并更新 handoff。

## PARKED

- 多 provider 方案一（YUK-921）、YUK-572 夜间教研 agent、YUK-832 HOLD 与 Architecture FULL 的生产观察均不属于 F5。
- 不新增 pg-boss job kind、child-process 或 code-cell handle：当前没有声明 owner 的真实 consumer。
- 本地脏 `main` 不清理、不覆盖；F5 只在外接卷隔离 worktree 中修改。

## BLOCKED-ON

- 生产部署与生产观察需单独授权；本次没有部署授权。
- 完整测试权威是 push 后的 exact-head GitHub `CI Gate`，本地 scoped 结果不替代它。
