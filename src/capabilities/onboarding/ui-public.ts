// Client-only public contribution surface.
export { default as ColdStart } from './ui/ColdStart';
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
export {
  RECOMPUTE_BADGE_ENABLED,
  summarizeMaturity,
} from './ui/recompute/recompute-core';

export const loadWelcomePage = () => import('./ui/WelcomePage').then((module) => module.default);
export const loadOnboardRecordPage = () =>
  import('./ui/OnboardRecord').then((module) => module.default);
export const loadPlacementPage = () =>
  import('./ui/ScreenPlacement').then((module) => module.default);
export const loadPlacementProfilePage = () =>
  import('./ui/ScreenProfile').then((module) => module.default);
