// Onboarding ④ · placement-done profile API client (YUK-473 Slice 4).
// Reads GET /api/placement/profile?goal=<id> — per-KC mastery over the goal scope,
// derived from the LIVE mastery_state projection (getMasteryProjection). In-scope KCs
// with no mastery_state row come back as tested:false (未测).

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

type PlacementProfileWire = ApiOperationJsonResponse<'getPlacementProfile'>;

// UI projection deliberately flattens the tested/untested discriminated union:
// views use optional evidence fields while `tested` remains the runtime gate.
// The transport boundary above remains generated from the manifest.
export interface ProfileKc {
  id: string;
  name: string;
  tested: boolean;
  evidence_count: number;
  theta_hat?: number;
  theta_precision?: number;
  theta_se?: number;
  p_l?: number;
  mastery_lo?: number;
  mastery_hi?: number;
  low_confidence?: boolean;
  success_count?: number;
  fail_count?: number;
  beta?: number;
  axis?: PlacementProfileWire['kcs'][number]['axis'];
  day_one_prior?: PlacementProfileWire['kcs'][number]['day_one_prior'];
}

export type PlacementProfile = Omit<
  PlacementProfileWire,
  'evidencedCount' | 'kcs' | 'sigma_mode' | 'weakest'
> & {
  kcs: ProfileKc[];
  weakest?: ProfileKc[];
  evidencedCount?: number;
  sigma_mode?: 'poly' | 'libm';
};

export const getPlacementProfile = (goalId: string): Promise<PlacementProfile> =>
  apiOperationJson('getPlacementProfile', {
    url: `/api/placement/profile?goal=${encodeURIComponent(goalId)}`,
    method: 'GET',
  });
