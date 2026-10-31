// Client-only public contribution surface.
import { type ReactNode, createElement } from 'react';
import type { CalibrationMaturityResponse } from './ui/recompute/calibration-maturity-api';
import { RcMaturityBadge as CalibrationMaturityBadge } from './ui/recompute/RecomputeComponents';
import {
  RECOMPUTE_BADGE_ENABLED as calibrationBadgeEnabled,
  summarizeMaturity as summarizeCalibrationMaturity,
} from './ui/recompute/recompute-core';

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
  usePlacementProfileClient,
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
export { RcMaturityBadge } from './ui/recompute/RecomputeComponents';
export { RECOMPUTE_BADGE_ENABLED, summarizeMaturity } from './ui/recompute/recompute-core';

// Coach 与 ScreenProfile 共用这枚徽章。函数写在公开面上，避免新增一条只转发的 re-export。
export function renderCalibrationMaturityBadge(data: CalibrationMaturityResponse): ReactNode {
  if (!calibrationBadgeEnabled) return null;
  return createElement(CalibrationMaturityBadge, { summary: summarizeCalibrationMaturity(data) });
}

export const loadWelcomePage = () => import('./ui/WelcomePage').then((module) => module.default);
export const loadOnboardRecordPage = () =>
  import('./ui/OnboardRecord').then((module) => module.default);
export const loadPlacementPage = () =>
  import('./ui/ScreenPlacement').then((module) => module.default);
export const loadPlacementProfilePage = () =>
  import('./ui/ScreenProfile').then((module) => module.default);
