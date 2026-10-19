# YUK-1553 共享知识工具 — 真实运行验收前置

> 状态：**前置清单（NOT RUN）**。本文只列出验收入口、数据与核对项；
> 不构造 mock 证据，不把静态检查当运行验收。runtime 窗口由父统一申请/取锁。
> 合并头：`032c83bc1`（d6e125a3 + merge origin/main@36b1346a）。

## 1. 已完成（本机，非运行）

- `pnpm typecheck` / `pnpm lint` / `pnpm lint:ratchet` / `pnpm build`：exit 0。
- `pnpm audit:capability-boundaries`：exit 0（total 442，knowledge -> ai 12）。
- `pnpm audit:tool-params`：exit 0 — `domain_tool(knowledge)` 6 工具（含
  `propose_knowledge_edge` / `propose_knowledge_mutation`）真实转换后 schema
  根 `type:"object"`、0 违规；私有 write_proposal custom-mount 扫描项已随
  该工具退役移除，改由 domain_tool 面覆盖。
- 源码静态对账：`knowledge_review` surface = 5 readers +
  2 propose 工具（`src/kernel/tools/allowlists.ts`）；Dreaming 显式列表继承
  同名集合（不再展开 KNOWLEDGE_REVIEW_TOOLS），无新增 grant。

## 2. 真实入口（验收时使用的生产路径，不新建 demo 入口）

| 入口 | 触发 | 挂载 | 说明 |
| --- | --- | --- | --- |
| `knowledge_maintenance_nightly` | YUK-758 DAG：orchestrator 在 `knowledge_edge_propose_nightly` 后软边触发，queue `agent`（`src/capabilities/knowledge/manifest.ts` jobs） | `streamReviewTask` → `piDomainMount('knowledge_review')` | KnowledgeReviewTask，原私有 `mcp__loom__write_proposal` 已退役 |
| `dreaming_nightly` | YUK-758 DAG 根，queue `llm`（`src/capabilities/agency/manifest.ts`） | `piDomainMount('dreaming')` + `allowedTools=resolveMcpAllowedTools('dreaming')` | 显式工具列表含两个共享 propose 工具 |
| 程序化兼容口 `runWriteProposal` | review.ts 导出，转发到同一注册工具实现 | 不经 pi mount | 既有调用者契约保持，无平行写路 |

## 3. 可使用的真实数据 / 旧 run

- 旧 `tool_call_log` 中 `mcp__loom__write_proposal` 行（d6 之前 run）作为
  迁移前基线：对比 wire 参数形状与 propose event 产物。
- 旧 KnowledgeReviewTask / DreamingTask `ai_task_runs` 行：对照新 run 的
  iterations / terminal / cost 量级。
- 生产知识树 + recent failure attempts 即 `buildReviewInput` 输入；
  agent_notes(for_agent='maintenance'|'dreaming') 是既有上下文通道。
- 验收环境需真实 provider（当前 pin `AI_PROVIDER_OVERRIDE`/`AI_PROVIDER_MODEL`
  所指的已准入 toolCalling 模型）+ 真实 Postgres；费用由父统一预算窗口核准。

## 4. 应核对的共享工具参数与提案记录

运行后逐项核对（真实 DB 行，非断言脚本）：

1. `tool_call_log` 新行 `tool_name` 为
   `mcp__loom__propose_knowledge_mutation` / `mcp__loom__propose_knowledge_edge`，
   `server=loom`、bridge 写入的 input/output/error_reason 齐全；同一 run 不再
   出现 `write_proposal` 行。
2. `propose_knowledge_mutation` 真实参数结构：discriminated union 5 分支
   （reparent/merge/split/archive/propose_new），`expected_version` 并发令牌
   为 tree 输入当前 version；`propose_knowledge_edge` 参数
   `{from_knowledge_id,to_knowledge_id,relation_type,weight?,reasoning,
   evidence_event_ids}` 或 archive 变体 —— 无 unknown/any 字段。
3. 重放/幂等：`skipped:duplicate_pending` / `skipped:cooldown` 状态在
   tool_call_log output 中可见（重复提议不二次写 event）；`cooldown_key` /
   `cooldown_until` 字段存在。
4. 可执行报错：非法 mutation 分支、错误 expected_version、缺失节点 id 时
   工具返回带字段名与修复指引的错误（isError 语义经 #1801 传播到 pi 终态）。
5. `event(action='propose')` 行与 inbox pending proposal 对应；
   `runWriteProposal` 兼容口若被调用，落同一 event 形态。
6. Dreaming 侧：`propose_*` 调用受 `DREAMING_MAX_PROPOSALS` cap 约束
   （超限返回停止提示文本），callerActor `agent:dreaming`。

## 5. 边界保证（不触未批准动作）

- 全部写路径只有 propose event；accept 仍走 inbox 人工路由 —— 验收 run
  不产生自动合并/reparent/archive 落地（`kc_dedup_nightly` 的 merge 提议同样
  只进 inbox）。
- 知识树真实改写只能在用户 accept 后发生；验收不对 pending proposal 做
  accept（除非父/owner 另行批准）。
- §9 批准的两项自动执行（疑似错判自动重判、双无作答同名同父 KC 自动合并）
  属 P4 lane，不在本 PR、不在本次验收内触发。
- 新增付费仅限验收 run 本身的模型调用；不引入新 provider、不改 paid 配置、
  不跑 preflight/付费脚本。

## 6. Missing（本 slice 未闭合，不算完成）

- 真实 KR / Dreaming run（需 runtime 窗口 + provider + DB）—— NOT RUN。
- P1 通用契约的其余部分（读工具 next/fields 白名单、统一报错面、按需暴露）
  与 1553 计划接受锁/父节点选择 —— 后续 ticket。
- P1 TEST 前后指标依赖 P0 记账（1557，外部 lane）。
- `tool_call_log` 对共享工具的 wire 级 JSONSchema 实测（audit:tool-params
  只核 post-conversion 静态 schema，NOT_RUN 声明沿用 Luna 盘点结论）。
