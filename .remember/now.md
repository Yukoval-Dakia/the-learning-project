# 当前 handoff — 2026-08-28 AI Pipeline Modernization F5 最终收口

## 已落地边界

- 根 Copilot 是前台交互；默认请求返回前台 SSE，只有 `durable:true` 显式创建 durable run。
- `ToolOperations` 只承载已声明 `safeHandoff` 的 remote read/idempotent tool；超过 45 秒时交出可 wait/poll/cancel 的 handle。write/propose、`run_task`、未拥有 MCP 与未证明安全的 tool 继续阻塞。
- `SubagentRuns` 有独立 durable mailbox、身份和 cancellation；完成后仅以幂等 one-shot continuation 恢复同一根请求，用户面没有第二个 agent 声音。
- Copilot drawer 的 operation/subagent 投影展示处理状态、结果、错误与停止动作；已清除 sequence、async、routing、durable/inline、subagent 协调等内部执行叙述。

## 合并记录

- #1302 YUK-926 `f64f1389`；#1303 YUK-927 `c8f90778`；#1304 YUK-930 `4c223bf5`；#1305 YUK-929 `e4e87b08`。
- #1306 YUK-928 `ad45e3e1`；#1307 YUK-931 `d28061d0341432417a97edd9d57750a7fd93c773`；#1308 YUK-932 `1cf06f575763fb72b558b6c8a2f064405a8a06bb`；#1309 YUK-933 `82eddbdfcfec66b7c11fa2269ebe0886bc405a45`。
- 当前 `origin/main` 是 #1309 的 `82eddbdf`。YUK-934 是最后的文档、audit 和 Postman 收口 lane，尚未合并。

## YUK-934 closeout

- 工作树：`/Volumes/YukovalSBak/yukoval-projects/the-learning-project-worktrees/f5-20260827/yuk-934`，branch `yuk-934-finalize-durable-modernization`。
- task census 真实值为 53 registered / 52 statically invoked / 1 compatibility（`AttributionTask`）；architecture audit 输出必须从 `auditTaskCensus()` 的结果派生，不能再写死旧的 50/1 值。
- 保留 correction-intent、retry 与 job-yield classifier；清除的只是 ordinary chat 的预测性 classifier / auto dual-track 叙述。没有 runtime-promotion consumer 或残留需要删除。
- Postman source 是 `postman/api-endpoints.json`；修改后必须运行 `pnpm gen:postman` 同步 collection，并用 `jq` 校验两份 JSON。

## 收口边界

- 不运行本机完整 `pnpm test` 或本地 gate；本机只可运行 scoped audit/unit/format 检查。push 后由 exact-head GitHub `CI Gate` 决定完整测试。
- 不部署、不做生产观察，也不清理主工作树或重装依赖。
- 合并前执行独立 review；合并后同步 Linear YUK-934 与 parent YUK-927，并做 closeout capture gate。
