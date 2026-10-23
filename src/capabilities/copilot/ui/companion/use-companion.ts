// React seam for the companion controller: one controller per mount, state read through
// useSyncExternalStore (zustand's useStore), and the server reads React Query schedules.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { apiJson } from '@/ui/lib/api';
import { useCopilotClient } from '../copilot-client';
import { type CompanionController, createCompanionController } from './companion-controller';
import { type CompanionState, selectionValidated } from './companion-state';

export function useCompanionController(): CompanionController {
  const client = useCopilotClient();
  const queryClient = useQueryClient();
  const instance = useId();
  const [controller] = useState(() => createCompanionController({ client, queryClient, instance }));
  return controller;
}

/** A primitive or stable slice of the state. */
export function useCompanion<T>(
  controller: CompanionController,
  select: (state: CompanionState) => T,
): T {
  return useStore(controller.store, select);
}

/** A derived array/object slice, compared shallowly so equal content does not re-render. */
export function useCompanionShallow<T>(
  controller: CompanionController,
  select: (state: CompanionState) => T,
): T {
  return useStore(controller.store, useShallow(select));
}

/**
 * While the companion shows a validated conversation, Query owns the read schedule: one read when
 * it becomes visible, then every 5 s (also in the background). Each read applies its snapshot in
 * request order and re-attaches every active run.
 */
export function useTurnPolling(controller: CompanionController): void {
  const open = useCompanion(controller, (s) => s.visit.open);
  const sessionId = useCompanion(controller, (s) => s.currentSessionId);
  const validated = useCompanion(controller, selectionValidated);
  useQuery({
    queryKey: ['copilot-turns', controller.instance, sessionId],
    queryFn: () => controller.runs.refetchTurns().catch(() => false),
    enabled: open && sessionId !== null && validated,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  });
}

export interface CompanionSummary {
  daily_focus: string;
  review_due_count: number;
  brief_global_md: string | null;
  dreaming_preview: Array<{ proposal_id: string; kind: string; brief: string }>;
  pending_proposals_total: number;
}

/** Today's summary (Coach focus, due reviews, brief, pending suggestions); only while open. */
export function useCompanionSummary(open: boolean) {
  return useQuery({
    queryKey: ['copilot-summary'],
    queryFn: () => apiJson<CompanionSummary>('/api/today/copilot-summary'),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });
}
