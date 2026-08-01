import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';

import { COPILOT_RUN_EVENTS } from './copilot-run-status';

/**
 * SQL twin of `isCopilotRunTerminalEvent`.
 *
 * `IS DISTINCT FROM` is deliberate: missing/malformed reasons fail closed as
 * terminal, while the one historical retry-frame reason (`error`) remains
 * outstanding. Keep all DB readers on this helper so backlog, replay gates and
 * checkpoint safety cannot drift apart again.
 */
export function copilotRunTerminalSql(eventType: SQLWrapper, payload: SQLWrapper): SQL<boolean> {
  return sql<boolean>`(
    ${eventType} = ${COPILOT_RUN_EVENTS.DONE}
    OR (
      ${eventType} = ${COPILOT_RUN_EVENTS.FAILED}
      AND ${payload}->>'reason' IS DISTINCT FROM 'error'
    )
  )`;
}
