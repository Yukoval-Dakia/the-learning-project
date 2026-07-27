// YUK-567 (教研团 Phase 0 / U4 备课台) — client wire types + caller for the 备课台
// conjecture card. Mirrors the server contract in
// src/capabilities/shell/server/prep-desk.ts (PrepDeskConjecture).
//
// Anti-guilt invariant (handoff §2a): NO internal calibration NUMBER crosses the
// wire — `confidence` / `predicted_p` / `baseline_p_at_induction` are absent from
// the server type AND from this mirror. The ONLY number here is `recurrence_count`
// (a failure-cell count ≥2, NOT a probability), which the handoff explicitly wires.

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type PrepDeskConjecturesResponse = ApiOperationJsonResponse<'listPrepDeskConjectures'>;
export type PrepDeskConjectureWire = PrepDeskConjecturesResponse['conjectures'][number];
export type PrepDeskEvidenceRefWire = PrepDeskConjectureWire['evidence'][number];

export const getPrepDeskConjectures = () =>
  apiOperationJson('listPrepDeskConjectures', {
    url: '/api/prep-desk/conjectures',
    method: 'GET',
  });
