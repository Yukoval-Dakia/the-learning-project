// Compatibility barrel for tests and non-route imports. The SPA router imports each
// surface module directly so one admin route never pulls the other two page bodies.
export { AdminCostSurface } from './admin-cost';
export { AdminFailuresSurface } from './admin-failures';
export {
  AdminRunsSurface,
  failedWindowNote,
  shortErrorSummary,
  timelineTone,
} from './admin-runs';
export type { AdminRunRow, TimelineEvent } from './admin-runs';
export type { AdminSurfaceProps } from './observability-shared';
