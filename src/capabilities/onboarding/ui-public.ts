// Client-only public contribution surface.
export { default as ColdStart } from './ui/ColdStart';
export { RcMaturityBadge } from './ui/recompute/RecomputeComponents';
export { getCalibrationMaturity } from './ui/recompute/calibration-maturity-api';
export type {
  CalibrationMaturityResponse,
  CalibrationMaturityRow,
} from './ui/recompute/calibration-maturity-api';
export {
  RECOMPUTE_BADGE_ENABLED,
  summarizeMaturity,
} from './ui/recompute/recompute-core';
export { getPlacementProfile } from './ui/profile-api';
export type {
  PlacementProfile,
  ProfileKc,
} from './ui/profile-api';
