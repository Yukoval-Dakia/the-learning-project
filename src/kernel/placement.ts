// placement facade：capability 包从这里取 sanctioned 的派发/终态化/供给锁/flag
// 面；不承载业务逻辑，只 re-export。
export {
  PLACEMENT_QUEUE_EXPIRY_MS,
  dispatchPlacementStarterClaim,
  isPlacementStarterJobLive,
  lockPlacementSupplyScopes,
  markPlacementStarterClaimTerminal,
  resolvePlacementStarterGoalAuthority,
  terminalizeLostPlacementDelivery,
} from '@/capabilities/practice/public';
export { placementProbeEnabled } from '@/server/session/placement';
