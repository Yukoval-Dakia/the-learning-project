// Client-only public contribution surface.

export type { AdminControlClient } from './ui/admin-control-client';
export { SubjectTraitsWireSchema } from './ui/admin-control-client';
export const loadEventDetailPage = () =>
  import('./ui/EventDetailPage').then((module) => module.default);
export const loadAdminRunsSurface = () =>
  import('./ui/admin-runs').then((module) => module.AdminRunsSurface);
export const loadAdminCostSurface = () =>
  import('./ui/admin-cost').then((module) => module.AdminCostSurface);
export const loadAdminFailuresSurface = () =>
  import('./ui/admin-failures').then((module) => module.AdminFailuresSurface);
export const loadAdminSubjectsSurface = () =>
  import('./ui/subjects').then((module) => module.AdminSubjectsSurface);
export const loadAdminSubjectTraitsSurface = () =>
  import('./ui/subject-traits').then((module) => module.AdminSubjectTraitsSurface);
export const loadAdminCoverageLatticeSurface = () =>
  import('./ui/coverage-lattice').then((module) => module.AdminCoverageLatticeSurface);
export const loadAdminConjectureScoresSurface = () =>
  import('./ui/conjecture-scores').then((module) => module.AdminConjectureScoresSurface);

export const loadAdminConfigSurface = () =>
  import('./ui/config').then((module) => module.AdminConfigSurface);
