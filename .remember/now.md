# 当前 handoff — 2026-09-05 AI pipeline 完整改造进行中

Owner：完成 AI pipeline 重构后，再讨论整个项目结构。不得把本轮再次停在单个切片完成。

## 工作树与已集成内容

- 原始 `/Volumes/YukovalSBak/yukoval-projects/the-learning-project` 是带用户改动的旧 main，保持原样。
- 集成工作树：`/Volumes/YukovalSBak/yukoval-projects/tlp-wt-pipeline-completion`，
  分支 `codex/yuk-939-pipeline-completion`，从 main `090e882c` 起步。
- `d286dcbd`：统一 runner SDK 消费核心（88 focused tests）。
- `51f7c0c8` + `e707a753`：两个 owner generation tools，删除 run_task 与 registry overlay，
  复用现有 capability runtime ports（85 integrated focused tests）。
- `593d2aea` + `7cd5890d`：前台与 Mission 原生 depth-1 只读 Task；停止新 safeHandoff，
  保持父请求结果回流、取消、审计和历史 mailbox 恢复。
- `10cc68ea`：七个旧控制工具退出 manifest 与实际 MCP 工具集合；保留 drain-only handlers。
- 验收脚本已集成至 `b004b0b5`：合成数据、独立 pgvector 容器、真实根入口；direct durable 不等于 queue E2E。

## 当前剩余

- `tlp-wt-root-finalization` 独立 lane 正在完成终态 JSON finalization、reply receipt 和双 evidence Task 退休。
  已否决必须调用私有 finalize_reply 工具的第一稿：会额外增加普通回复的模型回合。复用确定性校验，
  在 SDK terminal 后一次完成；runner 仅补中性的 terminalText，不理解 Copilot 产品字段。
- 集成后跑 scoped 单测/DB/static/build、独立审查、exact-head CI；尚未 push/PR/merge/部署本阶段。
- 实际 old-chain read 基准在 acceptance lane `914a378e`：root + blind 已确认 57,817 input、
  2,457 output、$0.201614；比较模型超时用量/费用未知，只能报告下界。
  Owner 已明确允许新链路最多新增 $2 真实验收。取消场景已真实验证零 provider attempts。
- Evidence path：`tlp-wt-actual-acceptance/.tmp/actual-provider-acceptance/1788607564405-9bc922a5-3d0a-44b8-99ed-f81c8e77e015.json`。
- SDK `bypassPermissions` 会跳过 canUseTool；安全闸必须在 PreToolUse 和实际工具 callback 中执行。

## 边界

普通回复的结构化 provenance 不证明语义真值；保留题目/解题/教学独立校验。
历史 checkpoint/table/task rows 不删；旧队列只排空，不继续接受新生产者。
Linear 返回 Unknown tool，未同步；生产未授权。完整任务状态与后续见 PLAN.md 和 completion plan。
