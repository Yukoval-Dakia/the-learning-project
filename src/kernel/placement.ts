// 内核 placement facade（薄壳，YUK-761）— 包装 Practice-owned question supply 与
// `@/server/session/*`。Capability 包只依赖 `@/kernel/*` + 自身 + 共享 UI 件
// （`src/capabilities/AGENTS.md` CONVENTIONS；迁移期豁免只给 kernel facade 与 `@/db/*`），
// 所以练习域的 placement starter claim 恢复清扫器从这里取派发 / 终态化 / 供给锁 / dark-ship
// flag。形制同 `@/kernel/judge`：不承载业务逻辑，只 re-export 被 sanctioned 的 placement 面。
export {
  PLACEMENT_QUEUE_EXPIRY_MS,
  dispatchPlacementStarterClaim,
  isPlacementStarterJobLive,
  lockPlacementSupplyScopes,
  markPlacementStarterClaimTerminal,
  resolvePlacementStarterGoalAuthority,
  terminalizeLostPlacementDelivery,
} from '@/capabilities/practice/public';
export { PLACEMENT_PROBE_ENABLED } from '@/server/session/placement';
