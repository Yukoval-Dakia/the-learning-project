# src/capabilities/knowledge — 知识图谱域

> "tree 是骨架，mesh 是肌肉"（ADR-0010）：`knowledge.parent_id` 主层级 backbone + `knowledge_edge` 有类型横向链接。节点/边 propose 都写 event，用户 accept 才落地。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 12 条 API 路由 + 7 个 cron/链式 job + 4 proposal kinds + 6 copilot tools |
| `api/*.ts` | tree / node-page / proposals / edges / review / frontier / misconceptions / veto |
| `server/` | tree、edges、proposals、rubric-validator、attribute、review、seed、domain/subject-profile |
| `jobs/` | `knowledge_edge_propose_nightly`、`frontier_fill_nightly`、`knowledge_maintenance_nightly`、`attribution_followup`、`kc_dedup_nightly`、`merge_attribution_sweep`、`projection_oracle_sweep` |
| `ui/KnowledgePage.tsx` / `KnowledgeDetailPage.tsx` | 知识面与节点详情页 |

## CONVENTIONS
- `relation_type` 核心 5 类：`prerequisite | related_to | contrasts_with | applied_in | derived_from`；新关系先用 `experimental:*`。
- 节点/edge/misconception 的 propose 都写 `event(action='propose')`，accept route 才执行真实 mutation。
- attribution 通过 chained judge event，`caused_by_event_id` 指向 attempt event。

## ANTI-PATTERNS
- 破坏性动作（合并节点 / reparent / archive / misconception veto）只能 propose，无直接 write tool。
- 别把整棵 `knowledge`/`knowledge_edge` 表塞进 prompt；用语义化 graph reader。
- 新 subject profile 改完先跑 `pnpm audit:profile`。
