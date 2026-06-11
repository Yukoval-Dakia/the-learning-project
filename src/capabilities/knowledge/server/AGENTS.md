# knowledge — 知识树 + mesh

> "tree 是骨架，mesh 是肌肉"（ADR-0010）：`knowledge.parent_id` 主层级 backbone + `knowledge_edge` 表承载有类型横向链接。领域词条见 [CONTEXT.md § 已批准](../../../CONTEXT.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `tree.ts` | parent_id 层级 backbone 读写 |
| `domain.ts` | 知识域 / subject scoping |
| `edges.ts` / `propose_edge.ts` | mesh edge CRUD + 提议（5 类 `relation_type` + `experimental:*`）|
| `hub-mesh.ts` | hub auto-zone / AutoLinksContainer 计算（hub_auto_sync_nightly 消费）|
| `node-page.ts` | 单节点页面聚合 reader |
| `propose.ts` / `proposals.ts` | 知识节点 propose event + accept/dismiss |
| `attribute.ts` | 错题归因（写 judge event，`payload.cause` 10 类，`caused_by_event_id` 链 attempt）|
| `review.ts` | KnowledgeReviewTask（维护流 producer）+ legacy `write_proposal` MCP tool 入口 |
| `rubric-validator.ts` | 知识 rubric 校验 |
| `seed.ts` | 种子知识树 |
| `subject-profile.ts` / `subject-resolution.ts` | SubjectProfile 解析（profile-driven task 用）|
| `validate.ts` | 节点/树结构校验 |
| `ai_failure_log.ts` | AI 提议失败留痕 |

## 关键约束
- `relation_type` 核心 5 类：`prerequisite | related_to | contrasts_with | applied_in | derived_from`，外加 `experimental:*` 命名空间。
- 节点/edge 的 propose 都写 `event(action='propose')`，**不直接改硬事实**——accept route 才落地真实 mutation。
- attribution 通过 chained judge event，`caused_by_event_id` 指向 attempt event。

## ANTI-PATTERNS
- 破坏性动作（合并节点 / reparent / archive）只能 propose，无直接 write tool。
- 新 subject profile 改完先跑 `pnpm audit:profile`（坏 profile 会在 `SubjectRegistry.register()` 启动期抛错）。
