# Abandoned Review Session Resume Design

## Scope

YUK-63 makes abandoned review sessions visible and recoverable. The target case is an ADR-0013 orphan cron marking a session `abandoned` after the user leaves before a normal close.

## Decisions

- Surface: add `/learning-sessions` as the list entrypoint for recent review sessions.
- Resume trigger: explicit `Resume` button only on `status='abandoned'` rows.
- State transition: `abandoned -> started`, clear `ended_at`, bump `version`, and write a `review.reopened` job event.
- Review entry: `/review?session=<id>` adopts existing `started` sessions, resumes `paused` sessions through the existing route, and reopens `abandoned` sessions through the new route.
- Data model: no schema change; `learning_session.status` is text and already carries `abandoned`.

## Boundaries

- No attempt replay or queue snapshot persistence in this lane. The resumed `/review` page uses the current review planner queue.
- No changes to the orphan cron cutoff.
- No new domain `event` row; session transitions continue to use `job_events`.
