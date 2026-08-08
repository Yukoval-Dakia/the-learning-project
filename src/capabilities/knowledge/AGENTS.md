# src/capabilities/knowledge — 知识图谱域

> "tree 是骨架，mesh 是肌肉"（ADR-0010）：`knowledge.parent_id` 主层级 backbone + `knowledge_edge` 有类型横向链接。节点/边 propose 都写 event，用户 accept 才落地。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | API、job、proposal kind、copilot tool 的组合声明 |
| `api/*.ts` | tree / node-page / proposals / edges / review / frontier / misconceptions / veto |
| `server/` | tree、edges、proposals、rubric-validator、review、seed、domain/subject-profile，以及给 Failure Learning 的有界 knowledge reader |
| `jobs/` | Knowledge 图谱维护、edge 提议、dedup、merge attribution 与 projection oracle 后台任务 |
| `ui/KnowledgePage.tsx` / `KnowledgeDetailPage.tsx` | 知识面与节点详情页 |

## CONVENTIONS
- `relation_type` 核心 5 类：`prerequisite | related_to | contrasts_with | applied_in | derived_from`；新关系先用 `experimental:*`。
- 节点/edge/misconception 的 propose 都写 `event(action='propose')`，accept route 才执行真实 mutation。
- Practice Failure Learning 只能经 `public.ts` 暴露的有界 reader 读取知识上下文；Knowledge 不拥有归因 workflow。

## ANTI-PATTERNS
- 破坏性动作（合并节点 / reparent / archive / misconception veto）只能 propose，无直接 write tool。
- 别把整棵 `knowledge`/`knowledge_edge` 表塞进 prompt；用语义化 graph reader。
- 新 subject profile 改完先跑 `pnpm audit:profile`。
