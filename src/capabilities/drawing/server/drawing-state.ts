// Drawing status sets — owned here (the arch rule lets schema.ts forward only
// real pgTable symbols). The union itself is declared on the table module.
import type { DrawingStatus } from '@/db/schema';

export const DRAWING_STATUSES = [
  'queued',
  'running',
  'ready',
  'waiting_quota',
  'waiting_login',
  'failed',
  'cancelled',
  'expired',
] as const satisfies readonly DrawingStatus[];

/** Live statuses: a same-content request dedupes onto this row. */
export const DRAWING_LIVE_STATUSES = [
  'queued',
  'running',
  'ready',
  'waiting_quota',
  'waiting_login',
] as const satisfies readonly DrawingStatus[];

/**
 * Statuses the hard TTL may fence to expired. `ready` is deliberately absent:
 * a served drawing only leaves ready through retraction or an explicit
 * lifecycle action — never because a clock ran out.
 */
export const DRAWING_EXPIRABLE_STATUSES = [
  'queued',
  'running',
  'waiting_quota',
  'waiting_login',
] as const satisfies readonly DrawingStatus[];

/** Terminal states a manual redraw may leave. */
export const DRAWING_REDRAWABLE_STATUSES = [
  'ready',
  'failed',
  'cancelled',
  'expired',
] as const satisfies readonly DrawingStatus[];
