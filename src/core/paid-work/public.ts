// Browser-safe public face of paid-work: the pure protocol's types only.
// Runtime protocol helpers (identity/digest decisions) live in
// ./protocol/paid-effect-protocol.ts and the transactional state machine in
// ./server/; neither is re-exported here, so importing this module never pulls
// node:crypto or database code into a browser graph.
export type {
  PaidEffectBackend,
  PaidEffectCancelReceipt,
  PaidEffectCancelRequest,
  PaidEffectControlAdmission,
  PaidEffectControlSnapshot,
  PaidEffectDeliveryRef,
  PaidEffectIdentity,
  PaidEffectInput,
  PaidEffectReservation,
  PaidEffectState,
  PaidEffectSuccessorDelivery,
  PaidEffectVoidAuthorization,
  PaidEffectVoidReceipt,
  VerifiedPaidEffectDispatchRef,
} from './protocol/paid-effect-protocol';
