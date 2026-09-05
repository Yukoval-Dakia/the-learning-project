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

- `fe71227b` 已集成终态 JSON finalization、reply receipt 和双 evidence Task 退休。
  静态/构建/多组 scoped 测试已通过。真实 read 格式回归修复与 durable FAILED 修复在独立 lane；
  初审仅一个 P1，剩一次修复验证审。尚未 push/PR/merge/部署本阶段。
- 新首轮 read 成本 $0.103107，33,652 input / 343 output；工具成功，但模型“正文 + 同文 fenced JSON”
  被严格解析挡住。第二轮 $0.091226 又返回纯正文，窄解码不足；累计 $0.194333，剩 $1.805667。
  Evidence: 集成树 `.tmp/actual-provider-acceptance/1788611012778-406b4b3d-d33a-491f-97ff-18c626f00373.json`。
  验收脚本现记录 synthetic terminal + digest，整段会话走真实 streaming（比较 read 仍走原 non-stream）。
- 最新架构裁决：删除模型 JSON 协议，明确以 SDK terminal Markdown 为 candidate；服务端生成
  observed_completed_tool_use_ids 和 execution_trace_bound 收据，不声称模型事实引用或语义正确。
  finalization worker 正实施该简化；attempt worker 正隔离 skill-enabled settingSources 到 user-only
  临时配置镜像，禁止 project/local 开发指令与 hooks 混入产品模型。两 lane 独立工作树。
- 实际 old-chain read 基准在 acceptance lane `914a378e`：root + blind 已确认 57,817 input、
  2,457 output、$0.201614；比较模型超时用量/费用未知，只能报告下界。
  Owner 已明确允许新链路最多新增 $2 真实验收。取消场景已真实验证零 provider attempts。
- Evidence path：`tlp-wt-actual-acceptance/.tmp/actual-provider-acceptance/1788607564405-9bc922a5-3d0a-44b8-99ed-f81c8e77e015.json`。
- SDK `bypassPermissions` 会跳过 canUseTool；安全闸必须在 PreToolUse 和实际工具 callback 中执行。

## 边界

最新进展：同输入 read 在 `5c2bdcad` 通过（28,464 input / 215 output / $0.076271），独立终审批准。
整轮 `86ff83c8` 到 native 场景失败，已知成本 $0.233001；此前 $0.270604，累计 $0.503605。
SDK 实际工具名是 Agent；其 tool_result 返回 Async agent launched，子任务尚未返回时父请求结束。
child transcript 有 5,988 input、没有完整终态用量/费用；已暂停付费并异步请求新增最多 $1。
worker `implement_native_research` 在新隔离树 `tlp-wt-native-sdk-compat` 修复。
整轮 correction 仅 clarify，不算成功；`12f77867` 补字符串数组类型并要求 receipt.corrected。
实际取消 `1788613455779-ab989fc4-9764-4bbb-8e2a-d2bcd678db4a.json` 通过，0 provider attempts。
不得称全验收完成；尚未 push/PR/merge/部署。

普通回复的结构化 provenance 不证明语义真值；保留题目/解题/教学独立校验。
历史 checkpoint/table/task rows 不删；旧队列只排空，不继续接受新生产者。
Linear 返回 Unknown tool，未同步；生产未授权。完整任务状态与后续见 PLAN.md 和 completion plan。
