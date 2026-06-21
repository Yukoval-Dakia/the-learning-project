// Onboarding ④ · placement-done profile API client (YUK-473 Slice 4).
// Reads GET /api/placement/profile?goal=<id> — per-KC mastery over the goal scope,
// derived from the LIVE mastery_state projection (getMasteryProjection). In-scope KCs
// with no mastery_state row come back as tested:false (未测).

import { apiJson } from '@/ui/lib/api';

export interface ProfileKc {
  id: string;
  name: string;
  tested: boolean;
  evidence_count: number;
  // present only when tested:
  theta_hat?: number;
  theta_precision?: number;
  theta_se?: number;
  /** p(L) point estimate, 0..1 (= the band mark). */
  p_l?: number;
  mastery_lo?: number;
  mastery_hi?: number;
  low_confidence?: boolean;
}

export interface PlacementProfile {
  goalId: string;
  title: string;
  kcs: ProfileKc[];
  /** Evidence summed across tested KCs — a coverage signal, NOT a distinct-question count
   * (one question labeled with N KCs contributes N). Computed over the full scope. */
  evidenceCount: number;
  /** Number of in-scope KCs that actually have evidence (a mastery_state row). */
  testedCount: number;
  /** Full in-scope KC count, before the surfaced list is capped (PROFILE_KC_LIMIT). */
  totalKcs: number;
}

export const getPlacementProfile = (goalId: string) =>
  apiJson<PlacementProfile>(`/api/placement/profile?goal=${encodeURIComponent(goalId)}`);
