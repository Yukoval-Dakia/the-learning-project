-- YUK-577 (Codex P2-2) — DB-enforced idempotency for the nudge companion (opened / dismissed) writes.
--
-- POST /api/copilot/nudges/[id]/{opened,dismissed} previously minted a fresh companion event on
-- every call, keyed by caused_by_event_id = <nudge event id>. A network retry or a fast double-click
-- would therefore write TWO opened (or dismissed) events for one nudge. The read model hides the
-- nudge after the first (EXISTS), so the UI looked fine — but the event-aggregated opened/dismissed
-- KPI (dismiss_rate = dismissed/(opened+dismissed)) would double-count, corrupting the honest-count
-- red line. These partial unique indexes cap it at at-most-one opened + at-most-one dismissed per
-- nudge at the DB layer; the route catches 23505 and treats a duplicate as already-recorded.
--
-- Partial (action-scoped), one per companion action, because caused_by_event_id is a shared chain
-- column across many event actions (a bare unique index would break every other writer, and a nudge
-- may legitimately have BOTH one opened and one dismissed). Hand-written because drizzle-kit does not
-- generate partial `WHERE …` indexes at this version (0060_yuk577_copilot_nudge_unique precedent);
-- index-only, schema model unchanged, so no meta snapshot needed. See
-- docs/design/2026-07-07-yuk577-proactive-triggers.md §3.6.
CREATE UNIQUE INDEX "event_copilot_nudge_opened_unique_idx" ON "event" ("caused_by_event_id") WHERE "action" = 'experimental:copilot_nudge_opened';
CREATE UNIQUE INDEX "event_copilot_nudge_dismissed_unique_idx" ON "event" ("caused_by_event_id") WHERE "action" = 'experimental:copilot_nudge_dismissed';
