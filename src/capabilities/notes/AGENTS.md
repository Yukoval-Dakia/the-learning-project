# src/capabilities/notes — Note artifact 域

> Living Note 的读、写、refine 与 generate durable handoff。artifact 笔记按 block-tree 编辑（乐观锁），Living Note refine 经 `note_refine` job 触发 → mutator 小改或 propose 大改。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | Notes-owned API、jobs、event subscription、proposal kind、copilot tools 与 todayBlock 的权威注册面 |
| `api/*.ts` | note-page、artifacts search/recent-ai-changes、body-blocks、backlinks、ai-changes/undo、editing-session heartbeat/blur |
| `server/` | note-page reader、body-blocks、artifact-corrections 读模型、refine、handoff、Notes boss port |
| `server/tools/` | copilot 工具（`write_note` = YUK-1769 伙伴 Markdown 直写；`check_note` = YUK-1772 只读检查） |
| `jobs/` | `hub_auto_sync_nightly`、`hub_sync_recovery`、`hub_sync_mutation_wake`、`note_refine`、`note_generate` handler |
| `server/note-handoff.ts` | generation intent/completion 的 append-only 记录与 deterministic pg-boss dispatch/readback；由 `hub_sync_recovery` floor 收敛 |
| `tasks/` | NoteGenerateTask / NoteRefineTask 的 prompt、profile builder、provider 与 budget 真相 |
| `ui/NoteReaderPage.tsx` | 笔记阅读器/编辑器 |

## CONVENTIONS
- 编辑器栈 = TipTap 3；block-tree 用 optimistic lock。
- 笔记正文提交（body_blocks + version + history）只经 `server/artifact-body-commit.ts`：调用方给出调用方事务与决策回调，入口持有行锁、版本 +1、块引用同步、成对 fold 事件与时间戳；入口不开事务、不拿 advisory 锁。精修（`note-refine-apply.ts`）与 hub 同步（`hub-sync-reconciliation.ts`）有各自事件/fence 语义，不经此入口。
- `note_refine` 触发源 = mastery_change / mark_wrong（dwell 已裁；verify 桥随 YUK-1772 退役；dreaming 订阅已删，夜间整理不再写笔记刷新事件）。mark_wrong 由错因归因完成后经 kernel 端口入队，1 小时防抖在 `note-refine-triggers.ts`。
- `note_generate` 只经同事务 intent + 提交后 dispatcher 衔接；completion 表示 queue dispatch 已确认，不表示模型业务完成。生成后不再有独立 AI 复审（YUK-1772）：确定性块契约检查在落盘前跑一次，发现问题交回同一条生成链做一次有界修订，未解决的 issue 写入 `verification_summary`（`kind='known_issues'`，仅在有未解决 issue 时非空）。
- `note_generate` 失败显式落 `failed`，pg-boss redelivery 用 CAS 重开为 `pending`；已 `ready` 的成功重投跳过。
- `check_note` copilotTool 对指定笔记跑同一套确定性检查，返回 issues 列表，不做 pass/fail，不拦截写入。
- `hub_sync_recovery` 是唯一 Notes 定时 recovery floor；hub reconcile 与 handoff/claim 分支隔离执行，claim batch 也会处理完其余项后聚合抛错，任一失败最终仍供 pg-boss 重试。
- `NotePatch ≤3 ops AND ≤2 new blocks` 走 mutator，否则 propose。

## ANTI-PATTERNS
- 别在客户端直接改 note body；所有持久化走 `/api/artifacts/[id]/body-blocks` 或 refine 链。
- `embedded_check` 孤儿链已删除（YUK-358 决定3）。
- editing-session heartbeat 只做 presence 写，不做 dwell refine。
