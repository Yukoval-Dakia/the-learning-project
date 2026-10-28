# YUK-57 — Review UX P2.2: skip + pause/resume session

**Branch**: `yuk-57-review-skip-pause-resume`（cascading 自 `yuk-52-note-markdown` tip `e5b197d`）
**Linear**: [YUK-57](https://linear.app/yukoval-studios/issue/YUK-57)（5pts, M2, Sub P2.2 / 8）
**Date**: 2026-05-24
**Pre-req ADRs**: ADR-0013（review session lifecycle）、ADR-0008（multi-type session）、ADR-0005（single-owner transition）

---

## 1. Goal

让 `/review` 页支持三个交互能力：

1. **跳过当前题**（skip）—— 不算 attempt，不动 FSRS state，只把 review queue 的 index 推进到下一道。
2. **暂停 session**（pause）—— 显式把 `learning_session.status` 从 `started` 推到 `paused`，让用户主观断点。
3. **恢复 session**（resume）—— 从 `paused` 推回 `started`，继续刷题。

并把这三个能力 wire 到现有 review page UI + cron + sendBeacon 路径，**不破坏** ADR-0013 已落地的 session lifecycle。

---

## 2. Key decisions（grep/read 验证后）

### D1. Skip 不算 attempt — UI-only state advance

**Decision**: skip 按钮 **不**写任何 `event` 行 / `job_events` 行 / 不调 `/api/review/submit`。它仅把客户端 `index` + 1、reset 答题输入 state，等价于「手动按 enter 跳过」。

**Why**:
- 用户主诉「我不知道但不想标 fail」—— `'again'` 是 1 月内复习，跳过更接近「这道我不评价，先过」语义。
- 写一个 `outcome='partial'` 或新 KnownEvent（`SkipOnQuestion`）会污染 FSRS 投影 + knowledge_mastery view（ADR-0012）的输入，得不偿失。
- 若日后需要「skip 也算行为」，可以在 plan 阶段再加 `experimental:skip` event；当前 ticket scope 仅 UX。

**Grep 验证**: `src/core/schema/event/known.ts:25-100` 有 `AttemptOnQuestion` / `ReviewOnQuestion`，**没有** `skip` action。`src/server/review/scheduler*` 路径所有 FSRS 推进都从 `event(action='review')` 派生（grep 后 `app/api/review/submit/route.ts` 是唯一写入点）。因此 skip 不调 submit = 不动 FSRS，零副作用。

### D2. Pause / Resume 需要新 status='paused'

**Decision**: 在 `learning_session.status` 字符串域里新增 `'paused'`。状态机扩展为：

```
started ⇄ paused
   ↓        ↓
completed  completed
   ↓        ↓
abandoned  abandoned
```

- `pauseReviewSession`: `started → paused`（违规 → 409）
- `resumeReviewSession`: `paused → started`（违规 → 409）
- `completeReviewSession`: 已存在 `started → completed`，扩展为 `started|paused → completed`
- `abandonReviewSession`: 已存在 `started → abandoned`，扩展为 `started|paused → abandoned`

**Why allowed-from 扩展**:
- 用户从 paused 直接关 tab → sendBeacon fallback 应能 close（completed）。
- cron orphan 扫到 paused 也得能 abandon。

**Schema**: `learning_session.status` 是 `text` 不是 enum（已 grep `src/db/schema.ts`），无需 migration —— 但要更新所有 status filter 处确认。

### D3. Paused session 进 6h orphan cron

**Decision**: `prune_orphan_review_sessions` 扩展为 `status IN ('started', 'paused')` AND `started_at < now() - 6h`。

**Why**:
- 跟 conversation session abandoned 6h cron 边界对齐（grep `src/server/boss/handlers/prune_orphan_review_sessions.ts:18-32`）。
- Paused session 留半天没回来 = abandoned，避免无限留 row。
- Linear ticket 备注里写「保守做法是 paused 进 orphan 扫」—— 跟 active 一样。
- 用户实际行为：pause 通常 5-30min（吃饭/打电话），6h 已经远超合理回归窗口。

**改动**: `prune_orphan_review_sessions.ts` selector + 测试加 paused 案例。

### D4. pagehide listener 在 paused 状态不发 sendBeacon

**PR #122 stale 项 fix**: 现在的 pagehide handler（`app/(app)/review/page.tsx:159-166`）一律发 `{ status:'completed' }`，这在 paused 状态会**错误**把 paused → completed。

**Decision**: pagehide 时检查最新 status：
- `status === 'started'` → 发 beacon `{ status:'completed' }`（保留现状）
- `status === 'paused'` → **不**发 beacon（让 cron 兜底处理）
- `status === 'completed'` → 已经关了，不发（保留现状）

**Why 不发而不是发 `{ status:'paused' }`**: paused 已经在 DB 里固化了；再发 beacon 是冗余 noise。让 cron 决定何时 abandon。

**Implementation**: pagehide handler 读 `sessionStatus` state（已存在的 React state）。但 React state 在 closure 里可能 stale —— 用 `useRef` 镜像 status，pagehide 读 ref 而不是 state。

### D5. Resume entry — 复用 SessionStrip（今日页 active session row）

**Decision**: `/today` 的 `SessionStrip` 已经显示 `status === 'started'` 的 session。扩展为也显示 `status === 'paused'` 的 session，按钮文案 `恢复 session` → 跳回 `/review?session=<id>`。

**Why 不专门做 `/learning-sessions` list page**:
- list page 不存在（grep `app/(app)/learning-sessions/` 只有 `[id]/page.tsx`），新建是 over-scope。
- SessionStrip 已经是「最近 session 入口」语义，paused 自然属于这层。
- Linear ticket 备注「与 P3.4（YUK-63）协调」—— P3.4 是 abandoned session resume；我们只需保证 `/review?session=<id>` URL param 能正确 wire 即可，结构上不锁死单一入口。

**`/review` page change**: 支持 `?session=<id>` query param → 若提供 + DB 该 session 是 paused → 调 resume route → 用此 sessionId 替代 eager 新建 session。

### D6. job_events emit pattern 与 `review.*` 平行

`pauseReviewSession` 写 `job_events.event_type='review.paused'`、`resumeReviewSession` 写 `'review.resumed'`（pattern 跟 `review.started/completed/abandoned` 一致，grep `src/server/session/review.ts:80,120,157`）。Skip 不写任何 server 事件（D1）。

---

## 3. Architecture

### File changes

**新增**:
- `app/api/review/sessions/[id]/pause/route.ts` — POST，pause transition + sendBeacon-friendly body parser
- `app/api/review/sessions/[id]/pause/route.test.ts` — DB-backed test（mirror end/route.test.ts）
- `app/api/review/sessions/[id]/resume/route.ts` — POST，resume transition
- `app/api/review/sessions/[id]/resume/route.test.ts` — DB-backed test

**修改**:
- `src/server/session/review.ts`：
  - 加 `pauseReviewSession(db, sessionId)`、`resumeReviewSession(db, sessionId)`
  - `completeReviewSession` allowed-from `['started']` → `['started','paused']`
  - `abandonReviewSession` allowed-from `['started']` → `['started','paused']`
- `src/server/session/review.test.ts`：加 pause/resume + paused→completed + paused→abandoned cases
- `src/server/boss/handlers/prune_orphan_review_sessions.ts`：selector `status='started'` → `status IN ('started','paused')`（drizzle `inArray`）
- `src/server/boss/handlers/prune_orphan_review_sessions.test.ts`：加 paused 老 session abandon 案例
- `app/(app)/review/page.tsx`：
  - 新 sessionStatusRef 镜像 sessionStatus，pagehide handler 读 ref
  - 加 skip button（review-stage answering phase 内）
  - 加 pause button（review-stage 顶部 progress row 旁）
  - 支持 `?session=<id>` resume：mount 时若 URL 有 sessionId + DB 是 paused → 调 resume route 而不是 POST `/api/review/sessions`
  - Done 状态 `SessionEndSummary` 已 OK 不动
- `app/(app)/today/page.tsx` (SessionStrip)：
  - active selector：`(s) => s.status === 'started'` → 加 paused 行 `(s) => s.status === 'paused'`
  - paused 行按钮文案：`恢复 session` → href `/review?session=<id>`
- `src/ui/components/ReviewSessionChrome.tsx`：
  - `ReviewSessionRibbon` 文案 hint 加 `status='paused'` 时的提示文案（`status='paused'` 时显示「session 已暂停 — 按继续接着刷」）
  - `SessionEndSummary` 不变

**审计**:
- `scripts/audit-schema-allowlist.json`：无需更新 —— `learning_session.status` 是 `text`，不是 enum；audit:schema 看的是 write path，pause/resume 都通过 transition fn 写 → 有 path。
- `pnpm audit:partition`：route.test 在 DB partition ✓
- `pnpm audit:profile`：无 subject profile 改动

### Status transition diagram

```
       startReviewSession
              │
              ▼
       ┌─────────────┐         pauseReviewSession         ┌────────────┐
       │   started   │  ──────────────────────────────►   │   paused   │
       │             │  ◄──────────────────────────────   │            │
       └──────┬──────┘         resumeReviewSession        └─────┬──────┘
              │                                                 │
              │ completeReviewSession                           │ completeReviewSession
              │ abandonReviewSession                            │ abandonReviewSession
              │ orphan cron 6h                                  │ orphan cron 6h
              ▼                                                 ▼
       ┌─────────────┐                                   ┌─────────────┐
       │  completed  │                                   │  abandoned  │
       │ /abandoned  │                                   │ /completed  │
       └─────────────┘                                   └─────────────┘
```

---

## 4. Open Q

**Q1**: `?session=<id>` resume 路径下，如果 DB 该 session 是 `completed`/`abandoned` 怎么处理？
- A: 显示「这次 session 已结束，开新的」+ 自动新开 session（保底 UX，不卡住）。

**Q2**: pause 时是否要清空当前题答题输入？
- A: **不清**，pause 是「我暂时离开但不丢上下文」语义。resume 时恢复原状（包括 answer textarea 内容）。但浏览器刷新后 textarea 内容会丢 —— 不在 ticket scope，不做 localStorage persistence。

**Q3**: skip 是否有键盘快捷键？
- A: 用 `s` / `S` key。理由：`a`/`1`/`2`/`3` 已被 review 占用；`s` 直观且不冲突。

**Q4**: paused session 没人手动 resume，cron 是 6h 还是 24h？
- A: 6h（与 started 对齐）。理由见 D3。

**Q5**: UI design pre-flight - 没有专用 design doc。属于「在 review page 加按钮 + state」+「在 today/SessionStrip 加 paused 行」。新元素仅复用 `<Button variant="ghost"/"secondary">` primitive + 现有 `Badge tone='info'` / `Badge tone='neutral'`，**不**新增 design token。
- Pause / Skip 按钮：`Button variant="ghost" size="sm"`，跟现有的 review-stage 风格（`btn-rating` 是 review rating bar 专用，对 secondary control 用 Button primitive 更一致）。
- 今日页 paused 行：复用 `ss-row` 样式 + `Badge tone="info" dot`（与 active 同 tone；paused 比 active 更弱，但比 completed 强）。

---

## 5. Tasks (TDD)

### Task 1: `pauseReviewSession` + `resumeReviewSession` + extend complete/abandon allowed-from

1. Red: 加 test in `src/server/session/review.test.ts`：
   - `pauseReviewSession`: started → paused + version bump + 'review.paused' job_event
   - `pauseReviewSession`: paused (already) → 409
   - `pauseReviewSession`: completed → 409
   - `resumeReviewSession`: paused → started + version bump + 'review.resumed'
   - `resumeReviewSession`: started → 409
   - `completeReviewSession`: paused → completed（**新允许**）
   - `abandonReviewSession`: paused → abandoned（**新允许**）
2. Green: 实现两个 fn + 改两个 allowed list
3. Run `pnpm vitest run --config vitest.db.config.ts src/server/session/review.test.ts`
4. Commit: `feat(review): YUK-57 pauseReviewSession / resumeReviewSession transitions + paused→complete/abandon`

### Task 2: pause/resume route handlers

1. Red: 加 `app/api/review/sessions/[id]/pause/route.test.ts` + `resume/route.test.ts`，mirror `end/route.test.ts`（JSON + sendBeacon body parse + 404 + bad status enum）
2. Green: copy `end/route.ts` body parse pattern；调 transition fn
3. Run partition + db tests for new files
4. Commit: `feat(review): YUK-57 pause/resume routes`

### Task 3: orphan cron 扫 paused

1. Red: 加 test case in `prune_orphan_review_sessions.test.ts`：6h paused session → abandoned
2. Green: 改 selector `inArray(status, ['started', 'paused'])`
3. Run `pnpm vitest run --config vitest.db.config.ts src/server/boss/handlers/prune_orphan_review_sessions.test.ts`
4. Commit: `feat(review): YUK-57 orphan cron prunes paused sessions`

### Task 4: review page wire skip + pause + sessionStatusRef + ?session= resume

1. Red: 用 `react-dom/server.renderToString` 写 unit-level smoke test in `app/(app)/review/page.test.ts`（如果没有则直接走 e2e 在 task5）
2. Green:
   - 加 `const sessionStatusRef = useRef<'started'|'paused'|'completed'>('started');`，每次 setSessionStatus 同时更新 ref。
   - pagehide handler 改读 ref：`if (sessionStatusRef.current === 'paused') return;`
   - 加 skip button (`onClick={handleSkip}`)：复制 `handleNext` 逻辑，不调 submit。
   - 加 pause button：在 progress row 旁；click → `apiJson('/api/review/sessions/${sessionId}/pause', {method:'POST'})` → setSessionStatus('paused') → setSessionStatusRef('paused') → show 「session 已暂停」 overlay + 继续 button → resume call。
   - mount 时若 `useSearchParams().get('session')` 有值且 GET `/api/learning-sessions/<id>` 返回 `type='review', status='paused'` → POST resume → 用此 id；否则 fallback 走 eager 新建。
   - Keybindings: `s` → skip, `p` → pause/resume toggle。
3. Commit: `feat(review): YUK-57 skip + pause/resume UI + pagehide paused guard`

### Task 5: today page SessionStrip 显示 paused

1. Green: 在 SessionStrip 加 paused row（`status === 'paused'`），按钮 `恢复 session` → `/review?session=<id>`
2. Commit: `feat(today): YUK-57 SessionStrip paused row + resume entry`

### Task 6: ReviewSessionRibbon paused 文案

1. Green: 在 `ReviewSessionRibbon` 加条件 `session.status === 'paused'` 时显示「⏸ session 已暂停 · 点继续接着刷」
2. Commit: `feat(review): YUK-57 ReviewSessionRibbon paused hint`

### Task 7: Pre-merge gate

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test
```

---

## 6. Risk + Rollback

**Risk 1**: paused status 漏到某处 status enum check 报错。
- 检查点：grep `'completed' \|'started' \|'abandoned'` 看是否有 union check 漏 paused。
- Mitigation: 全 grep + 测试覆盖。

**Risk 2**: pagehide handler ref 时序问题 —— pause 调用 + setSessionStatus + ref update 之间 user 立刻 close tab。
- Mitigation: pause POST resolve 后立刻 `sessionStatusRef.current = 'paused'`（在 setState 之前）。Ref 不受 React 批量更新影响，立即生效。

**Risk 3**: 客户端 race —— `?session=<id>` resume 时 mount 同时调 GET + POST resume + POST 新 session 三个请求。
- Mitigation: 串行；先 GET，根据结果决定 resume 或新建；用 cancelled flag 防 unmount race（已有 pattern）。

**Risk 4**: pause/resume 同时被多个 tab 并发触发（多 tab 看到同一 paused session）。
- Mitigation: transition fn 有 `assertFromState` 守护；第二个并发 resume 会 409。UI 显示「这个 session 已经被另一个 tab 操作了」并 fallback 新建 session。**但本 ticket scope 仅做基本路径**，多 tab race 不专门处理（与 ADR-0013 §"接受的代价" 一致：跨 tab 不做单例）。

**Rollback**: 全部改动 reversible：
- migration-less（status 是 text）—— 把 paused row 手动 update 成 abandoned 即恢复。
- routes 删除 → 客户端 404 fallback。
- transition fn 删除 → 调用方报错。
- UI button 删除 → 不影响 review submit / FSRS。

---

## 7. Exit criteria

- [ ] 7 个 commit landed in `yuk-57-review-skip-pause-resume`
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm lint` PASS
- [ ] `pnpm audit:schema` PASS
- [ ] `pnpm audit:partition` PASS
- [ ] `pnpm audit:profile` PASS
- [ ] `pnpm test` PASS（全量含 DB）
- [ ] Plan 关键决策（D1-D6）在 commit message / PR body 中可追溯
- [ ] PR #122 两个 stale 项已处理：BadgeTone='warning' 不使用（用 'info' / 'neutral'）；pagehide listener 在 paused 状态不发 beacon

---

## 8. Linear capture gate

可能发现的 follow-ups（lane 完成后报告时给 orchestrator）：

- 候选 #1: localStorage persist current answer textarea content over pause/resume + page reload（Q2 答案 = 不做，但日后值得 ticket）
- 候选 #2: cross-tab race 单例锁（Risk 4）—— 与 ADR-0013 §"接受的代价" 一致，不做；如果实际遇到再开 issue
- 候选 #3: paused session 在 `/learning-sessions/[id]` detail page 的展示（当前已显示 status，但没专门的「pick up where you left off」CTA）—— follow-up ticket 候选

不预先创建 Linear ticket，只在 lane 完成报告里列。

---

## 9. YUK-58 conflict heads-up

本 lane touch `app/(app)/review/page.tsx` 的范围：
- L133-135: 加 `sessionStatusRef`、status enum 加 `'paused'`
- L137-179: pagehide handler 改 + `?session=<id>` resume 处理（**集中改动 useEffect**）
- L296-310: 加 `handleSkip` / `handlePause` / `handleResume`
- L332-356: keybinding 加 `s` / `p`
- L433-450: progress row 加 pause/skip 按钮（少量 JSX 新增）
- 不重命名 state、不重排 sections、不大改 layout

YUK-58 (attempt timeline) 预计改 feedback phase JSX + 加新 component，**与本 lane 改 answering phase 按钮 + useEffect 解耦**，conflict 应该可控（手动 merge resolve）。
