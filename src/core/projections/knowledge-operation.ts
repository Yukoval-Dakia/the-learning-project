// Strict decoder for the v1 `knowledge_operation` fact carried inside an accept
// `rate` event payload. The raw payload is inspected BEFORE the generic RateEvent
// Zod strip: key absent → callers stay on the legacy path; valid v1 → one
// normalised operation; present but undecodable → UndecodableKnowledgeOperationError.
// It never falls back to legacy, skips, or reports empty targets for a present key.

export const KNOWLEDGE_OPERATION_KEY = 'knowledge_operation';

export type KnowledgeOperationDecodeReason =
  // key present but value is null / non-object / carries unknown fields
  | 'malformed_operation'
  // key present on a rate that is not a valid accept (rating/envelope)
  | 'not_accept_rate'
  | 'unknown_version'
  | 'unknown_kind'
  | 'invalid_targets'
  // declared reference missing/mistyped or inconsistent with the operation
  | 'invalid_reference'
  // materialized_ids does not equal the effect=create target ids
  | 'materialized_mismatch'
  // envelope caused_by/subject do not match the declared operation/decision refs
  | 'envelope_mismatch'
  // a referenced fact event does not exist (fact/accept/correction/proposal)
  | 'missing_fact'
  // a referenced event exists but does not match what the target/ref declares
  | 'mismatched_fact';

export class UndecodableKnowledgeOperationError extends Error {
  readonly eventId: string;
  readonly reason: KnowledgeOperationDecodeReason;

  constructor(eventId: string, reason: KnowledgeOperationDecodeReason, detail?: string) {
    // No payload text in the message: event id + reason code (+ field-level detail).
    super(
      `undecodable knowledge_operation on event ${eventId}: ${reason}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'UndecodableKnowledgeOperationError';
    this.eventId = eventId;
    this.reason = reason;
  }
}

export interface KnowledgeOperationTarget {
  kind: 'knowledge' | 'knowledge_edge';
  id: string;
  effect: 'create' | 'archive';
  before_version?: number;
  after_version?: number;
  fact_event_id?: string;
}

export type KnowledgeOperationV1 =
  | {
      version: 1;
      kind: 'create';
      /** The proposal event this accept materialises (P in the design docs). */
      proposal_event_id: string;
      targets: KnowledgeOperationTarget[];
    }
  | {
      version: 1;
      kind: 'archive';
      /** The original birth-accept rate event being retracted (R_birth). */
      retracts_accept_event_id: string;
      /** The cross-kind retract correction event (C), written before the archive. */
      correction_event_id: string;
      targets: KnowledgeOperationTarget[];
    };

const OPERATION_FIELDS = new Set([
  'version',
  'kind',
  'targets',
  'proposal_event_id',
  'retracts_accept_event_id',
  'correction_event_id',
]);
const TARGET_FIELDS = new Set([
  'kind',
  'id',
  'effect',
  'before_version',
  'after_version',
  'fact_event_id',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

type Fail = (reason: KnowledgeOperationDecodeReason, detail?: string) => never;

// Per-kind targets the operation declares as newly minted. The legacy
// materialized_ids compat field must equal exactly this set per kind.
export function createdTargetIds(
  op: { targets: KnowledgeOperationTarget[] },
  kind: KnowledgeOperationTarget['kind'],
): string[] {
  return op.targets.filter((t) => t.kind === kind && t.effect === 'create').map((t) => t.id);
}

function decodeTargets(
  raw: unknown,
  opKind: 'create' | 'archive',
  proposalEventId: string | undefined,
  fail: Fail,
): KnowledgeOperationTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) fail('invalid_targets');
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const at = `targets[${index}]`;
    if (!isRecord(entry)) fail('invalid_targets', at);
    for (const key of Object.keys(entry)) {
      if (!TARGET_FIELDS.has(key)) fail('invalid_targets', `${at}.${key}`);
    }
    const { kind, id, effect, before_version, after_version, fact_event_id } = entry;
    if (kind !== 'knowledge' && kind !== 'knowledge_edge') fail('invalid_targets', `${at}.kind`);
    if (!isId(id)) fail('invalid_targets', `${at}.id`);
    if (effect !== 'create' && effect !== 'archive') fail('invalid_targets', `${at}.effect`);
    if (effect !== opKind) fail('invalid_targets', `${at}.effect`);
    if (before_version !== undefined && !isVersion(before_version)) {
      fail('invalid_targets', `${at}.before_version`);
    }
    if (after_version !== undefined && !isVersion(after_version)) {
      fail('invalid_targets', `${at}.after_version`);
    }
    if (fact_event_id !== undefined && !isId(fact_event_id)) {
      fail('invalid_reference', `${at}.fact_event_id`);
    }
    if (!seen.add(`${kind}:${id}`)) fail('invalid_targets', `${at} duplicate`);

    if (kind === 'knowledge' && effect === 'archive') {
      if (before_version === undefined || after_version === undefined) {
        fail('invalid_targets', `${at} requires before_version/after_version`);
      }
      if (after_version !== before_version + 1) {
        fail('invalid_targets', `${at} after_version must be before_version + 1`);
      }
    } else if (kind === 'knowledge_edge') {
      // Edges carry no version column; a stamped version is a shape error.
      if (before_version !== undefined || after_version !== undefined) {
        fail('invalid_targets', `${at} versions`);
      }
    } else if (
      before_version !== undefined ||
      (after_version !== undefined && after_version !== 0)
    ) {
      // knowledge create: no base version; the folded row starts at version 0.
      fail('invalid_targets', `${at} versions`);
    }

    if (effect === 'archive' && fact_event_id === undefined) {
      fail('invalid_reference', `${at}.fact_event_id`);
    }
    if (opKind === 'create' && fact_event_id !== undefined && fact_event_id !== proposalEventId) {
      fail('invalid_reference', `${at}.fact_event_id`);
    }
    return { kind, id, effect, before_version, after_version, fact_event_id };
  });
}

function normaliseMaterializedIds(
  payload: Record<string, unknown>,
  fail: Fail,
): Record<'knowledge' | 'knowledge_edge', string[]> {
  const raw = payload.materialized_ids;
  const out: Record<'knowledge' | 'knowledge_edge', string[]> = {
    knowledge: [],
    knowledge_edge: [],
  };
  if (raw === undefined) return out;
  if (!isRecord(raw)) fail('materialized_mismatch');
  // Same strictness as the Zod materialized_ids (.strict()): an unknown key must
  // fail here too so the two validators can never disagree on one payload.
  for (const key of Object.keys(raw)) {
    if (key !== 'knowledge' && key !== 'knowledge_edge') fail('materialized_mismatch', key);
  }
  for (const kind of ['knowledge', 'knowledge_edge'] as const) {
    const ids = raw[kind];
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) fail('materialized_mismatch', kind);
    const valid = ids.filter(isId);
    if (valid.length !== ids.length) fail('materialized_mismatch', kind);
    out[kind] = valid;
  }
  return out;
}

/**
 * Decode the `knowledge_operation` key of one rate event's raw payload.
 * Returns 'absent' when the key is not present; throws on a present-but-undecodable
 * key. Envelope consistency that does not need other events (caused_by/subject vs
 * the declared references, materialized_ids vs the created set) is checked here;
 * existence and content of the referenced fact events is the gather's job.
 */
export function decodeKnowledgeOperation(input: {
  eventId: string;
  subjectId: string;
  causedByEventId: string | null;
  payload: unknown;
}): KnowledgeOperationV1 | 'absent' {
  const { eventId, subjectId, causedByEventId, payload } = input;
  const fail: Fail = (reason, detail) => {
    throw new UndecodableKnowledgeOperationError(eventId, reason, detail);
  };

  if (!isRecord(payload) || !Object.hasOwn(payload, KNOWLEDGE_OPERATION_KEY)) return 'absent';

  // The key is only valid on an accept rate; anything else is undecodable, never
  // silently skipped. Envelope fields the payload cannot express (actor/outcome)
  // are checked by the RateEvent parse at the call sites.
  if (payload.rating !== 'accept') fail('not_accept_rate');

  const raw = payload[KNOWLEDGE_OPERATION_KEY];
  if (!isRecord(raw)) fail('malformed_operation');
  for (const key of Object.keys(raw)) {
    if (!OPERATION_FIELDS.has(key)) fail('malformed_operation', key);
  }
  if (raw.version !== 1) fail('unknown_version');
  if (raw.kind !== 'create' && raw.kind !== 'archive') fail('unknown_kind');
  const opKind = raw.kind;

  const materialized = normaliseMaterializedIds(payload, fail);
  const decodeAndCheckTargets = (proposalId: string | undefined) => {
    const targets = decodeTargets(raw.targets, opKind, proposalId, fail);
    for (const kind of ['knowledge', 'knowledge_edge'] as const) {
      const declared = createdTargetIds({ targets }, kind);
      const legacy = materialized[kind];
      if (
        declared.length !== legacy.length ||
        new Set(declared).size !== declared.length ||
        !declared.every((id) => legacy.includes(id))
      ) {
        fail('materialized_mismatch', kind);
      }
    }
    return targets;
  };

  if (opKind === 'create') {
    const proposalEventId = raw.proposal_event_id;
    if (!isId(proposalEventId)) fail('invalid_reference', 'proposal_event_id');
    if (raw.retracts_accept_event_id !== undefined || raw.correction_event_id !== undefined) {
      fail('invalid_reference');
    }
    const targets = decodeAndCheckTargets(proposalEventId);
    if (causedByEventId !== proposalEventId || subjectId !== proposalEventId) {
      fail('envelope_mismatch');
    }
    return { version: 1, kind: 'create', proposal_event_id: proposalEventId, targets };
  }

  const retractsAcceptEventId = raw.retracts_accept_event_id;
  const correctionEventId = raw.correction_event_id;
  if (!isId(retractsAcceptEventId)) fail('invalid_reference', 'retracts_accept_event_id');
  if (!isId(correctionEventId)) fail('invalid_reference', 'correction_event_id');
  if (raw.proposal_event_id !== undefined) fail('invalid_reference', 'proposal_event_id');
  const targets = decodeAndCheckTargets(undefined);
  const nodeArchiveFacts = new Set(
    targets.filter((t) => t.kind === 'knowledge').map((t) => t.fact_event_id),
  );
  if (
    causedByEventId === null ||
    subjectId !== causedByEventId ||
    !nodeArchiveFacts.has(causedByEventId)
  ) {
    fail('envelope_mismatch');
  }
  return {
    version: 1,
    kind: 'archive',
    retracts_accept_event_id: retractsAcceptEventId,
    correction_event_id: correctionEventId,
    targets,
  };
}
