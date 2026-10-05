// YUK-1016 / 454-B — cause_category_overlay 读面（capability-local 门面）。
//
// 实现在 kernel read-models（该投影同时被 ingestion 的 cause 入口用，跨
// capability 共享读归 kernel 层——同 failure-attempts / cause-policy 先例）。
// 写路径唯一：`cause_category` proposal 的 accept applier（proposal-appliers.ts
// 的 acceptCauseCategoryProposal）。

export {
  CAUSE_OVERLAY_ID_PREFIX,
  type CauseCategoryOverlayRow,
  getCauseCategoryOverlaysByIds,
  listActiveCauseCategoryOverlays,
  overlayToCandidate,
  withActiveCauseCategoryOverlays,
} from '@/kernel/read-models/cause-overlay';
