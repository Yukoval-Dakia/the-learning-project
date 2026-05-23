import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  type CorrectionStatus,
  activeCorrectionStatus,
  getCorrectionStatus,
} from '@/server/events/corrections';
import { eq } from 'drizzle-orm';

type DbLike = Db | Tx;

export type EffectiveTruthState = CorrectionStatus['state'] | 'missing' | 'cycle';
export type EffectiveTruthTerminalState =
  | 'active'
  | 'retracted'
  | 'marked_wrong'
  | 'missing'
  | 'cycle';

export interface EffectiveTruthStep {
  event_id: string;
  state: CorrectionStatus['state'];
  correction_event_id: string | null;
  replacement_event_id: string | null;
}

export interface EffectiveTruth {
  original_event_id: string;
  state: EffectiveTruthState;
  terminal_state: EffectiveTruthTerminalState;
  effective_event_id: string | null;
  correction_event_id: string | null;
  replacement_event_id: string | null;
  chain: EffectiveTruthStep[];
}

const MAX_SUPERSEDE_DEPTH = 16;

function stepFromStatus(eventId: string, status: CorrectionStatus): EffectiveTruthStep {
  return {
    event_id: eventId,
    state: status.state,
    correction_event_id: status.correction_event_id,
    replacement_event_id: status.replacement_event_id,
  };
}

export function activeEffectiveTruth(eventId: string): EffectiveTruth {
  return {
    original_event_id: eventId,
    state: 'active',
    terminal_state: 'active',
    effective_event_id: eventId,
    correction_event_id: null,
    replacement_event_id: null,
    chain: [stepFromStatus(eventId, activeCorrectionStatus())],
  };
}

function missingEffectiveTruth(
  originalEventId: string,
  chain: EffectiveTruthStep[],
): EffectiveTruth {
  return {
    original_event_id: originalEventId,
    state: 'missing',
    terminal_state: 'missing',
    effective_event_id: null,
    correction_event_id: null,
    replacement_event_id: null,
    chain,
  };
}

function cycleEffectiveTruth(originalEventId: string, chain: EffectiveTruthStep[]): EffectiveTruth {
  return {
    original_event_id: originalEventId,
    state: 'cycle',
    terminal_state: 'cycle',
    effective_event_id: null,
    correction_event_id: null,
    replacement_event_id: null,
    chain,
  };
}

function finalTruth(
  originalEventId: string,
  effectiveEventId: string,
  terminalStatus: CorrectionStatus,
  chain: EffectiveTruthStep[],
): EffectiveTruth {
  if (terminalStatus.state === 'superseded') {
    return cycleEffectiveTruth(originalEventId, chain);
  }
  const firstSupersede = chain.find((step) => step.state === 'superseded');
  const state: EffectiveTruthState =
    firstSupersede && terminalStatus.state === 'active' ? 'superseded' : terminalStatus.state;
  const stateOwner =
    state === 'superseded'
      ? firstSupersede
      : chain.findLast((step) => step.state === terminalStatus.state);

  return {
    original_event_id: originalEventId,
    state,
    terminal_state: terminalStatus.state,
    effective_event_id: effectiveEventId,
    correction_event_id: stateOwner?.correction_event_id ?? null,
    replacement_event_id:
      firstSupersede?.replacement_event_id ?? terminalStatus.replacement_event_id,
    chain,
  };
}

async function eventExists(db: DbLike, eventId: string): Promise<boolean> {
  const rows = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  return rows.length > 0;
}

export async function getEffectiveTruth(db: DbLike, eventId: string): Promise<EffectiveTruth> {
  let currentEventId = eventId;
  const seen = new Set<string>();
  const chain: EffectiveTruthStep[] = [];

  for (let depth = 0; depth < MAX_SUPERSEDE_DEPTH; depth += 1) {
    if (seen.has(currentEventId)) {
      return cycleEffectiveTruth(eventId, chain);
    }
    seen.add(currentEventId);

    if (!(await eventExists(db, currentEventId))) {
      return missingEffectiveTruth(eventId, chain);
    }

    const status = await getCorrectionStatus(db, currentEventId);
    chain.push(stepFromStatus(currentEventId, status));

    if (status.state !== 'superseded') {
      return finalTruth(eventId, currentEventId, status, chain);
    }

    currentEventId = status.replacement_event_id;
  }

  return cycleEffectiveTruth(eventId, chain);
}

export async function getEffectiveTruths(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, EffectiveTruth>> {
  const uniqueIds = [...new Set(eventIds)];
  const entries = await Promise.all(
    uniqueIds.map(async (eventId) => [eventId, await getEffectiveTruth(db, eventId)] as const),
  );
  return new Map(entries);
}
