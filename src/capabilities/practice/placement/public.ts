// 定位 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）。根 `public.ts` 按名字转出这里的操作，所以这里的
// 静态导出会进入根 barrel 的静态加载链；会话读写与开测入口保持按需加载。

export {
  type PlacementProfileResponse,
  UpdatePlacementSessionBodySchema,
} from './api/placement-contracts';
export { validatePlacementSubmission } from './server/placement-assessment';
export { readPlacementProfile } from './server/placement-profile';
export { selectNextPlacementItem } from './server/placement-select';
export {
  PlacementOrphanStateError,
  abandonOrphanPlacementTx,
  placementProbeEnabled,
  selectOrphanPlacementCandidates,
} from './server/placement-session-lifecycle';
export { releaseHeldPlacement } from './server/session-operations/placement-held-release';
export { selectNextPlacementQuestion } from './server/session-operations/placement-next';

// Resolve the existing session operation in the initialized host graph after auth.
export const readPlacementSession: typeof import('./server/session-operations/placement-session').readPlacementSession =
  async (...args) =>
    (await import('./server/session-operations/placement-session')).readPlacementSession(...args);

export const transitionPlacementSession: typeof import('./server/session-operations/placement-session').transitionPlacementSession =
  async (...args) =>
    (await import('./server/session-operations/placement-session')).transitionPlacementSession(
      ...args,
    );

export const startPlacementProbe: typeof import('./server/session-operations/placement-session').startPlacementProbe =
  async (...args) =>
    (await import('./server/session-operations/placement-session')).startPlacementProbe(...args);
