# knowledge — 知识树 + mesh

> "tree 是骨架，mesh 是肌肉"（ADR-0010）：`knowledge.parent_id` 主层级 backbone + `knowledge_edge` 表承载有类型横向链接。领域词条见 [CONTEXT.md § 已批准](../../../../CONTEXT.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `tree.ts` | parent_id 层级 backbone 读写 |
| `domain.ts` | 知识域 / subject scoping |
| `edges.ts` / `propose_edge.ts` | mesh edge CRUD + supersede 受理（5 类 `relation_type` + `experimental:*`）|
| `edge-proposal-write.ts` | 边提议事件唯一写者：冷却键、gate 锁内查重、payload、`validate: 'rubric' \| 'bootstrap'` |
| `node-page.ts` | 单节点页面聚合 reader |
| `tools/knowledge-state.ts` | `get_knowledge_state`：一个知识点的掌握带、证据、衰减、到期、连续错、错因和保留度 |
| `proposals.ts` | 知识节点 propose event + accept/dismiss（content-driven：cold-start-bridge / image-candidate-accept / agent proposal-tools / KnowledgeReviewTask 的写路径）|
| `review.ts` | KnowledgeReviewTask（维护流 producer）：经 `knowledge_review` surface 挂共享 `propose_knowledge_*` 工具 |
| `rubric-validator.ts` | 知识 rubric 校验 |
| `seed.ts` | 种子知识树 |
| `subject-profile.ts` / `subject-resolution.ts` | SubjectProfile 解析（profile-driven task 用）|
| `validate.ts` | 节点/树结构校验 |

## 关键约束
- Failure Learning 的 eligibility、归因与变式提议归 Practice。有界 knowledge / misconception 读在 `src/kernel/read-models/failure-learning-context.ts`。
