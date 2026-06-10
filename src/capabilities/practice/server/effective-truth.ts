import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  type CorrectionStatus,
  activeCorrectionStatus,
  getCorrectionStatuses,
} from '@/server/events/corrections';
import { inArray } from 'drizzle-orm';

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

export async function getEffectiveTruth(db: DbLike, eventId: string): Promise<EffectiveTruth> {
  return (
    (await getEffectiveTruths(db, [eventId])).get(eventId) ?? missingEffectiveTruth(eventId, [])
  );
}

export async function getEffectiveTruths(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, EffectiveTruth>> {
  const uniqueIds = [...new Set(eventIds)];
  const out = new Map<string, EffectiveTruth>();
  const pending = new Map(
    uniqueIds.map((eventId) => [
      eventId,
      {
        original_event_id: eventId,
        current_event_id: eventId,
        seen: new Set<string>(),
        chain: [] as EffectiveTruthStep[],
      },
    ]),
  );

  while (pending.size > 0) {
    const currentIds = [...new Set([...pending.values()].map((cursor) => cursor.current_event_id))];
    const existingRows =
      currentIds.length === 0
        ? []
        : await db.select({ id: event.id }).from(event).where(inArray(event.id, currentIds));
    const existingIds = new Set(existingRows.map((row) => row.id));
    const statuses = await getCorrectionStatuses(db, currentIds);

    for (const [originalEventId, cursor] of pending) {
      const currentEventId = cursor.current_event_id;
      if (cursor.seen.has(currentEventId)) {
        out.set(originalEventId, cycleEffectiveTruth(originalEventId, cursor.chain));
        pending.delete(originalEventId);
        continue;
      }
      cursor.seen.add(currentEventId);

      if (!existingIds.has(currentEventId)) {
        out.set(originalEventId, missingEffectiveTruth(originalEventId, cursor.chain));
        pending.delete(originalEventId);
        continue;
      }

      const status = statuses.get(currentEventId) ?? activeCorrectionStatus();
      cursor.chain.push(stepFromStatus(currentEventId, status));

      if (status.state !== 'superseded') {
        out.set(originalEventId, finalTruth(originalEventId, currentEventId, status, cursor.chain));
        pending.delete(originalEventId);
        continue;
      }

      cursor.current_event_id = status.replacement_event_id;
    }
  }

  return out;
}
