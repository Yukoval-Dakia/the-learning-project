# src/capabilities/notes — Note artifact 域

> Living Note 的读、写、refine 链。artifact 笔记按 block-tree 编辑（乐观锁），Living Note refine 经 `note_refine` job 触发 → mutator 小改或 propose 大改。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 13 条 API 路由 + 3 个 job 归属（2 有 load）+ 1 proposal kind + todayBlock |
| `api/*.ts` | note-page、artifacts search/recent-ai-changes、body-blocks、sections、backlinks、correct、ai-changes/undo、hub-dismiss-link、editing-session heartbeat/blur |
| `server/` | note-page reader、body-blocks、sections、refine triggers/policy/mutator/propose、ai-changes |
| `jobs/` | `hub_auto_sync_nightly`、`note_refine`；`note_generate`/`note_verify` 为归属元数据（仍注册在 `src/server/boss/handlers/`） |
| `ui/NoteReaderPage.tsx` | 笔记阅读器/编辑器 |

## CONVENTIONS
- 编辑器栈 = TipTap 3；block-tree 用 optimistic lock。
- `note_refine` 触发源 = mark_wrong / mastery_change / dreaming / verify（dwell 已裁）。
- `NotePatch ≤3 ops AND ≤2 new blocks` 走 mutator，否则 propose。

## ANTI-PATTERNS
- 别在客户端直接改 note body；所有持久化走 `/api/artifacts/[id]/body-blocks` 或 refine 链。
- 别把 embedded_check 孤儿链当可用路径（YUK-358 决定3 已真删）。
- editing-session heartbeat 现在纯 presence 写，不做 dwell refine。
