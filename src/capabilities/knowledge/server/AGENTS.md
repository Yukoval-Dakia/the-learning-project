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
| `proposals.ts` | 知识节点 propose event + accept/dismiss（content-driven：cold-start-bridge / image-candidate-accept / agent proposal-tools / KnowledgeReviewTask 的写路径）|
| `failure-learning-context.ts` | 给 Practice Failure Learning 的有界、保序、active-only knowledge reader |
| `review.ts` | KnowledgeReviewTask（维护流 producer）+ legacy `write_proposal` MCP tool 入口 |
| `rubric-validator.ts` | 知识 rubric 校验 |
| `seed.ts` | 种子知识树 |
| `subject-profile.ts` / `subject-resolution.ts` | SubjectProfile 解析（profile-driven task 用）|
| `validate.ts` | 节点/树结构校验 |

## 关键约束
- `relation_type` 核心 5 类：`prerequisite | related_to | contrasts_with | applied_in | derived_from`，外加 `experimental:*` 命名空间。
- 节点/edge 的 propose 都写 `event(action='propose')`，**不直接改硬事实**——accept route 才落地真实 mutation。
- Failure Learning 的 eligibility、归因与变式提议归 Practice；本包只提供 knowledge context reader。

## ANTI-PATTERNS
- 破坏性动作（合并节点 / reparent / archive）只能 propose，无直接 write tool。
- 新 subject profile 改完先跑 `pnpm audit:profile`（坏 profile 会在 `SubjectRegistry.register()` 启动期抛错）。
