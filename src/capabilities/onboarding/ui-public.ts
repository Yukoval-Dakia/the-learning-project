// Client-only public contribution surface.
import { createElement } from 'react';
import type { CalibrationMaturityResponse } from './ui/recompute/calibration-maturity-api';
import { RcMaturityBadge } from './ui/recompute/RecomputeComponents';
import { RECOMPUTE_BADGE_ENABLED, summarizeMaturity } from './ui/recompute/recompute-core';

export { default as ColdStart } from './ui/ColdStart';
export {
  type IngestionSessionCreateClient,
  IngestionSessionCreateClientProvider,
} from './ui/ingestion-session-create-client';
export {
  type GoalClient,
  GoalClientProvider,
  type PlacementClient,
  PlacementClientProvider,
  type PlacementProfileClient,
  PlacementProfileClientProvider,
  httpPlacementClient,
} from './ui/placement-client';
export type {
  PlacementProfile,
  ProfileKc,
} from './ui/profile-api';
export { getPlacementProfile } from './ui/profile-api';
export type {
  CalibrationMaturityResponse,
  CalibrationMaturityRow,
} from './ui/recompute/calibration-maturity-api';
export { getCalibrationMaturity } from './ui/recompute/calibration-maturity-api';

/** Coach 校准面顶部的成熟度对账徽章；gate 与 ScreenProfile 相同。 */
export function CalibrationMaturityBadge({ data }: { data: CalibrationMaturityResponse }) {
  if (!RECOMPUTE_BADGE_ENABLED) return null;
  return createElement(RcMaturityBadge, { summary: summarizeMaturity(data) });
}

export const loadWelcomePage = () => import('./ui/WelcomePage').then((module) => module.default);
export const loadOnboardRecordPage = () =>
  import('./ui/OnboardRecord').then((module) => module.default);
export const loadPlacementPage = () =>
  import('./ui/ScreenPlacement').then((module) => module.default);
export const loadPlacementProfilePage = () =>
  import('./ui/ScreenProfile').then((module) => module.default);
