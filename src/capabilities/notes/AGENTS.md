# src/capabilities/notes — Note artifact 域

> Living Note 的读、写、refine 与 generate/verify durable handoff。artifact 笔记按 block-tree 编辑（乐观锁），Living Note refine 经 `note_refine` job 触发 → mutator 小改或 propose 大改。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 13 条 API 路由 + Notes-owned job 唯一注册面 + 1 proposal kind + todayBlock |
| `api/*.ts` | note-page、artifacts search/recent-ai-changes、body-blocks、sections、backlinks、correct、ai-changes/undo、hub-dismiss-link、editing-session heartbeat/blur |
| `server/` | note-page reader、body-blocks、sections、artifact-corrections 读模型、refine、handoff、verification claim、Notes boss port |
| `server/tools/` | copilot 工具（`author_artifact` / `update_artifact`，YUK-880 归属） |
| `jobs/` | `hub_auto_sync_nightly`、`note_refine`、`note_generate`、`note_verify` handler |
| `server/note-handoff.ts` | append-only versioned intent/completion、deterministic pg-boss dispatch/readback；由 `hub_sync_recovery` floor 收敛 |
| `tasks/` | NoteGenerateTask / NoteVerifyTask 的 prompt、profile builder、provider 与 budget 真相 |
| `ui/NoteReaderPage.tsx` | 笔记阅读器/编辑器 |

## CONVENTIONS
- 编辑器栈 = TipTap 3；block-tree 用 optimistic lock。
- `note_refine` 触发源 = mark_wrong / mastery_change / dreaming / verify（dwell 已裁）。
- `note_generate` / `note_verify` 只经同事务 intent + 提交后 dispatcher 衔接；completion 表示 queue dispatch 已确认，不表示模型业务完成。
- `note_generate` 失败显式落 `failed`，pg-boss redelivery 用 CAS 重开为 `pending`；已 `ready` 的成功重投跳过。
- `note_verify` 远程调用不得持有 DB transaction；artifact version + fence/token claim 保护 reserve、raw-result stage 与短事务 finalize。provider attempt 只在 central runner durable start 后、真实 query 前原子计数；每个 artifact epoch 上限 3 次，触顶同事务投影 claim `attempts_exhausted` 与 artifact `verification_status='failed'`，只有新 epoch 重置。
- `hub_sync_recovery` 是唯一 Notes 定时 recovery floor；hub reconcile 与 handoff/claim 分支隔离执行，claim batch 也会处理完其余项后聚合抛错，任一失败最终仍供 pg-boss 重试。
- `NotePatch ≤3 ops AND ≤2 new blocks` 走 mutator，否则 propose。

## ANTI-PATTERNS
- 别在客户端直接改 note body；所有持久化走 `/api/artifacts/[id]/body-blocks` 或 refine 链。
- 别把 embedded_check 孤儿链当可用路径（YUK-358 决定3 已真删）。
- editing-session heartbeat 现在纯 presence 写，不做 dwell refine。
