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
  /** evidence summed across tested KCs (per-KC; coverage signal, not distinct questions). */
  answeredCount: number;
}

export const getPlacementProfile = (goalId: string) =>
  apiJson<PlacementProfile>(`/api/placement/profile?goal=${encodeURIComponent(goalId)}`);
