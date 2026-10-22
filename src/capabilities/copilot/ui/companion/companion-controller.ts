// Assembles one companion controller per mount. Components read CompanionState and call these
// commands from event handlers and ref callbacks; nothing here runs during render.

import type { QueryClient } from '@tanstack/react-query';
import { createStore } from 'zustand/vanilla';
import type { CopilotOpenRequest } from '@/ui/lib/use-copilot-dwell';
import type { CopilotClient } from '../copilot-client';
import { handleOpenRequest, initializeFromStorage } from './arrivals';
import { type CompanionCtx, createInternals, makeUpdateMessages } from './companion-context';
import { type CompanionState, initialCompanionState } from './companion-state';
import { type RunTracker, createRunTracker } from './run-tracker';
import { type TurnActions, createTurnActions } from './turn-actions';
import { type TurnSender, createTurnSender } from './turn-sender';
import { type VisitSessions, createVisitSessions } from './visit-sessions';

export interface CompanionController {
  store: CompanionCtx['store'];
  instance: string;
  sessions: VisitSessions;
  runs: RunTracker;
  sender: TurnSender;
  actions: TurnActions;
  /** Once per mount: restore the policy preference and every unconfirmed send. */
  initializeFromStorage: () => void;
  /** Claim one open request from a page; `requestOpen` asks the shell to open the panel. */
  handleOpenRequest: (request: CopilotOpenRequest, requestOpen: () => void) => void;
}

export function createCompanionController(deps: {
  client: CopilotClient;
  queryClient: QueryClient;
  instance: string;
}): CompanionController {
  const store = createStore<CompanionState>(() => initialCompanionState);
  const internals = createInternals();
  // The module factories below fill these in; every call happens after construction.
  const ctx = {
    store,
    get: store.getState,
    set: (patch: Partial<CompanionState>) => store.setState(patch),
    client: deps.client,
    queryClient: deps.queryClient,
    instance: deps.instance,
    internals,
    updateMessages: makeUpdateMessages(store, internals),
  } as CompanionCtx;
  ctx.sessions = createVisitSessions(ctx);
  ctx.runs = createRunTracker(ctx);
  ctx.sender = createTurnSender(ctx);
  return {
    store,
    instance: deps.instance,
    sessions: ctx.sessions,
    runs: ctx.runs,
    sender: ctx.sender,
    actions: createTurnActions(ctx),
    initializeFromStorage: () => initializeFromStorage(ctx),
    handleOpenRequest: (request, requestOpen) => handleOpenRequest(ctx, request, requestOpen),
  };
}
