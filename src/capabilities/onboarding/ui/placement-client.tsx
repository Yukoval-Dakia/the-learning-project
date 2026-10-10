import { createContext, useContext } from 'react';
import type { ApiOperationJsonResponse, ApiOperationRequestBody } from '@/ui/lib/api';
import type { SessionTransitionRequestOptions } from '@/ui/lib/session-transition';
import { createGoal } from './onboarding-api';
import {
  getPlacementSession,
  placementEnd,
  placementNext,
  saveProbeResponseDraft,
  startPlacement,
  submitProbeAnswer,
} from './placement-api';
import { getPlacementProfile } from './profile-api';
import { getCalibrationMaturity } from './recompute/calibration-maturity-api';

// Placement and profile transports (YUK-1438). The HTTP adapters are the default; the Start
// shell provides its RPC clients, which carry the same methods and wire types.
export type PlacementClient = {
  startPlacement: typeof startPlacement;
  getPlacementSession: typeof getPlacementSession;
  placementNext: typeof placementNext;
  placementEnd: (
    sessionId: string,
    status: 'completed' | 'abandoned',
    options?: SessionTransitionRequestOptions,
  ) => ReturnType<typeof placementEnd>;
  submitProbeAnswer: typeof submitProbeAnswer;
  saveResponseDraft: (
    issuanceId: string,
    body: ApiOperationRequestBody<'saveResponseDraft'>,
    options?: { keepalive?: boolean },
  ) => Promise<ApiOperationJsonResponse<'saveResponseDraft'>>;
  /** Absent over HTTP: the poller follows the receipt's poll_url instead. */
  readJudgeRunStatus?: (runId: string) => Promise<ApiOperationJsonResponse<'getJudgeRunStatus'>>;
};
export const httpPlacementClient: PlacementClient = {
  startPlacement,
  getPlacementSession,
  placementNext,
  placementEnd,
  submitProbeAnswer,
  saveResponseDraft: saveProbeResponseDraft,
};
const PlacementClientContext = createContext<PlacementClient | undefined>(undefined);
export const PlacementClientProvider = PlacementClientContext.Provider;
export function usePlacementClient(): PlacementClient {
  return useContext(PlacementClientContext) ?? httpPlacementClient;
}

export type PlacementProfileClient = {
  getPlacementProfile: typeof getPlacementProfile;
  getCalibrationMaturity: typeof getCalibrationMaturity;
};
export const httpPlacementProfileClient: PlacementProfileClient = {
  getPlacementProfile,
  getCalibrationMaturity,
};
const PlacementProfileClientContext = createContext<PlacementProfileClient | undefined>(undefined);
export const PlacementProfileClientProvider = PlacementProfileClientContext.Provider;
export function usePlacementProfileClient(): PlacementProfileClient {
  return useContext(PlacementProfileClientContext) ?? httpPlacementProfileClient;
}

// At-entry goal creation for Welcome; the Start shell provides its RPC client.
export type GoalClient = { createGoal: typeof createGoal };
export const httpGoalClient: GoalClient = { createGoal };
const GoalClientContext = createContext<GoalClient | undefined>(undefined);
export const GoalClientProvider = GoalClientContext.Provider;
export function useGoalClient(): GoalClient {
  return useContext(GoalClientContext) ?? httpGoalClient;
}
