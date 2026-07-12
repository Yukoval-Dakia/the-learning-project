// YUK-567 (教研团 Phase 0 / U4 备课台) — client wire types + caller for the 备课台
// conjecture card. Mirrors the server contract in
// src/capabilities/shell/server/prep-desk.ts (PrepDeskConjecture).
//
// Anti-guilt invariant (handoff §2a): NO internal calibration NUMBER crosses the
// wire — `confidence` / `predicted_p` / `baseline_p_at_induction` are absent from
// the server type AND from this mirror. The ONLY number here is `recurrence_count`
// (a failure-cell count ≥2, NOT a probability), which the handoff explicitly wires.

import { apiJson } from '@/ui/lib/api';

export interface PrepDeskEvidenceRefWire {
  kind: string;
  id: string;
}

/** Mirror of server `PrepDeskConjecture` (prep-desk.ts). Calibration numbers absent by design. */
export interface PrepDeskConjectureWire {
  /** conjecture id === proposal event id (no separate row). */
  id: string;
  claim: string;
  knowledge_id: string;
  cause_category: string;
  /** The UNRUN discriminating probe text — the question the team is about to ask. */
  probe_md: string;
  /** Failure-cell recurrence (≥2). The one wired number; not a probability. */
  recurrence_count: number;
  discriminating: boolean;
  corrected_by_owner: boolean;
  evidence: PrepDeskEvidenceRefWire[];
  proposed_at: string;
}

export interface PrepDeskConjecturesResponse {
  conjectures: PrepDeskConjectureWire[];
}

export const getPrepDeskConjectures = () =>
  apiJson<PrepDeskConjecturesResponse>('/api/prep-desk/conjectures');
