# Start notes list migration

## Required behavior and scope

Owner direction in `docs/planning/2026-10-07-non-ui-migration-priority.md:9`: "先完成整个非 UI 技术迁移，保留现有页面及行为；视觉设计与 UI 重写暂缓". That paragraph also says "必要的路由和数据接线属于迁移". Component type: route/page adapter. Preserve the existing NotesPage layout, text, controls,250ms search debounce, subject selection, loading/error/retry/empty states and note-detail/knowledge navigation.

HTTP currently validates NoteListQuerySchema before resolving subject knowledge IDs and listing notes. No subject means no filter; an empty resolved subject set means no rows. Use the existing resolver and listNotes with an injected Db|Tx. Keep active-note types, archive filtering, title/body substring escaping, ordering and full ISO DTO. Do not add pagination or change whitespace validation to match an inaccurate comment. Subject catalog is a separate existing consumer; preserve its behavior through the existing authenticated Start workbench path where available.

## Owned files

- New `server/start/notes-list-*` thin readers, authenticated adapter, server function, client and scoped tests; `server/start/routes/notes.tsx` and generated routeTree.
- Notes public/ui-public exports, necessary typed list operation under notes/server, existing notes-list HTTP adapter, list-only part of notes-api and NotesPage client injection; corresponding tests. Reuse current listNotes/resolver rather than duplicate selectors.
- `web/src/router.tsx` only the notes list document handoff and a focused Start NotesPage test. Existing protocol/usability fixture registrations/counts and generated Postman artifacts only if actual changes require them.
- This implementation report. Parent owns PLAN/remember and acceptance evidence.

Do not modify note detail, editor/presence, writes, AI tasks/jobs, manifest, schema/migrations, packages/lock, Vite, canonical boot or judge/restore sources. The list migration does not complete the Notes task family or remove the entire SPA.

## Verification and delivery

Author uses scoped unit/static/build and relevant audits only; no DB/Testcontainers/runtime/provider/install/push/PR/watch. Prepare meaningful DB tests for parent execution with actual transaction injection and an independent observer. Cover no-subject versus empty/unknown/custom/alias subject, inherited knowledge domains, archived notes/knowledge, note types, combined title/body query and escaped wildcards, boundary validation, full DTO and no writes. Auth/token+epoch must precede parsing/import/DB access. Real parent built RPC/browser acceptance must cover cold auth, invalid input, subjects/search/empty/error-retry, navigation and database no-write snapshots. Source/unit, DB, installed protocol, browser and CI evidence stay separate.

Independent review and exact-head CI are required before merge. Keep1358/1359 In Progress. No runtime changes are implied. Base main7472, carried prior ownership-only docs; no judge WIP is integrated.
