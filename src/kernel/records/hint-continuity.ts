import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { type HelpProviderFault, isHelpProviderFault } from '@/ai/help-provider-fault';
import { canonicalHash } from '@/core/migration/canonical';
import { HintPublication, type HintPublicationT } from '@/core/schema/event/assistance-publication';
import type { Db, Tx } from '@/db/client';
import { assessment_issuance, event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { issuanceRowToContract } from './assessment-issuance';
import { loadIssuanceStudyCoordinate, recordStudyAssistanceExposure } from './study-reference';
import { lockStudySources, studyMaterialAssetIds } from './study-sources';

type Coordinate = { issuanceId: string; questionId: string };
export type StoredHint = { id: string; publication: HintPublicationT };
const claimId = (input: Coordinate, rung: number) => `hint-claim:${input.issuanceId}:${rung}`;
const exposureId = (input: Coordinate, rung: number) => `hint-body:${input.issuanceId}:${rung}`;

/** Root/source rows precede issuance; this operation never acquires an evaluation-group lock. */
export async function withStudyAuthorization<T>(
  db: Db | Tx,
  input: Coordinate,
  run: (
    tx: Tx,
    coordinate: Extract<
      Awaited<ReturnType<typeof loadIssuanceStudyCoordinate>>,
      { status: 'assistable' }
    >,
    binding: string,
    sources: string,
    sourceEpochs: Record<string, string>,
  ) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    const loaded = await loadIssuanceStudyCoordinate(tx, input.issuanceId, input.questionId);
    if (loaded.status !== 'assistable')
      throw new ApiError('study_restricted', 'issued help is unavailable', 409);
    await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, loaded.revision.group_id))
      .for('update');
    const sources = await lockStudySources(
      tx,
      loaded.revision.revision_id,
      loaded.revision.group_id,
      loaded.revision.structure.parts.map((part) => part.part_id),
      studyMaterialAssetIds(loaded.revision.structure.materials),
    );
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, input.issuanceId))
      .for('update');
    if (
      !issuance ||
      canonicalHash(issuanceRowToContract(issuance).binding) !==
        canonicalHash(issuanceRowToContract(loaded.issuance).binding)
    ) {
      throw new ApiError('coordinate_mismatch', 'issued coordinate changed', 409);
    }
    return run(
      tx,
      { ...loaded, issuance },
      canonicalHash(issuanceRowToContract(issuance).binding),
      canonicalHash(sources),
      Object.fromEntries(sources.documents.map((document) => [document.id, document.epoch])),
    );
  });
}

async function readHints(tx: Tx, input: Coordinate, binding: string, sources: string) {
  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_assistance'),
        eq(event.subject_id, input.issuanceId),
        sql`${event.payload}->>'kind' = 'hint'`,
      ),
    )
    .orderBy(event.dispatch_seq);
  const hints: StoredHint[] = [];
  let legacy = false;
  for (const row of rows) {
    if (!row.payload.publication) {
      legacy = true;
      continue;
    }
    const parsed = HintPublication.safeParse(row.payload.publication);
    if (!parsed.success)
      throw new ApiError('hint_history_invalid', 'saved hint cannot be verified', 409);
    const p = parsed.data;
    if (
      p.binding_digest !== binding ||
      p.source_digest !== sources ||
      p.question_id !== input.questionId ||
      p.body_digest !== canonicalHash(p.body) ||
      Buffer.byteLength(p.body) > 16384 ||
      p.rung !== hints.length ||
      canonicalHash(p.prior) !==
        canonicalHash(hints.map((h) => ({ id: h.id, digest: h.publication.body_digest })))
    ) {
      throw new ApiError('hint_history_invalid', 'saved hint coordinate or prefix differs', 409);
    }
    hints.push({ id: row.id, publication: p });
  }
  return { hints, legacy };
}

async function sequenceClaim(
  tx: Tx,
  input: Coordinate,
  binding: string,
  sources: string,
  rung: number,
) {
  const [claim] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:hint_generation_claim'),
        sql`${event.payload}->>'binding_digest' = ${binding}`,
        sql`${event.payload}->>'source_digest' = ${sources}`,
        sql`${event.payload}->>'question_id' = ${input.questionId}`,
        sql`${event.payload}->>'rung' = ${String(rung)}`,
      ),
    )
    .limit(1);
  return claim;
}

export async function restoreIssuedHints(db: Db, input: Coordinate) {
  return withStudyAuthorization(db, input, async (tx, coordinate, binding, sources) => {
    let state = await readHints(tx, input, binding, sources);
    const [pending] = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, claimId(input, state.hints.length)));
    if (!state.legacy && !pending) {
      const candidates = await tx
        .select({ issuanceId: event.subject_id })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:assessment_assistance'),
            ne(event.subject_id, input.issuanceId),
            sql`${event.payload}->'publication'->>'binding_digest' = ${binding}`,
            sql`${event.payload}->'publication'->>'source_digest' = ${sources}`,
            sql`${event.payload}->'publication'->>'question_id' = ${input.questionId}`,
          ),
        )
        .orderBy(desc(sql`${event.payload}->'publication'->>'rung'`), desc(event.dispatch_seq))
        .limit(1);
      const sourceId = candidates.find((row) => row.issuanceId !== input.issuanceId)?.issuanceId;
      if (sourceId) {
        const source = await readHints(tx, { ...input, issuanceId: sourceId }, binding, sources);
        if (
          source.hints.length > state.hints.length &&
          state.hints.some(
            (hint, i) => hint.publication.body_digest !== source.hints[i]?.publication.body_digest,
          )
        )
          throw new ApiError('hint_history_invalid', 'saved sequences disagree', 409);
        const copied: StoredHint[] = [...state.hints];
        for (const hint of source.hints.slice(state.hints.length)) {
          const publication = {
            ...hint.publication,
            source_exposure_id: hint.id,
            prior: copied.map((h) => ({ id: h.id, digest: h.publication.body_digest })),
          };
          const id = await recordStudyAssistanceExposure(tx, {
            ...input,
            kind: 'hint',
            impact: 'unknown',
            actorRef: 'assessment:assistance',
            dose: publication.rung,
            contentDigest: `sha256:${publication.body_digest}`,
            eventId: exposureId(input, publication.rung),
            publication,
          });
          copied.push({ id, publication });
        }
        state = { hints: copied, legacy: state.legacy || source.legacy };
      }
    }
    const sequencePending = await sequenceClaim(tx, input, binding, sources, state.hints.length);
    return {
      status: state.legacy
        ? 'legacy_body_unavailable'
        : pending || sequencePending
          ? 'outcome_unknown'
          : state.hints.length
            ? 'ready'
            : 'empty',
      issuance_id: input.issuanceId,
      revision_id: coordinate.revision.revision_id,
      hints: state.hints,
      next_rung: state.hints.length,
    };
  });
}

export async function claimIssuedHint(
  db: Db,
  input: Coordinate & { rung: number; requestId: string },
) {
  if (!Number.isInteger(input.rung) || input.rung < 0 || input.rung > 4)
    throw new ApiError('hint_rung_invalid', 'only the next hint may be requested', 409);
  return withStudyAuthorization(db, input, async (tx, coordinate, binding, sources) => {
    const state = await readHints(tx, input, binding, sources);
    const id = claimId(input, input.rung);
    const [request] = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.subject_id, input.issuanceId),
          eq(event.action, 'experimental:hint_generation_claim'),
          sql`${event.payload}->>'request_id' = ${input.requestId}`,
        ),
      );
    if (request && request.id !== id)
      throw new ApiError(
        'hint_request_conflict',
        'request identity was already used for another rung',
        409,
      );
    const [existing] = await tx.select().from(event).where(eq(event.id, id));
    const saved = state.hints[input.rung];
    if (saved)
      return {
        status: 'restored' as const,
        hint: saved,
        prior: state.hints.slice(0, input.rung),
        claimId: id,
      };
    if (existing || (await sequenceClaim(tx, input, binding, sources, input.rung)))
      throw new ApiError(
        'hint_outcome_unknown',
        'a prior request may have been sent; automatic retry is disabled',
        409,
      );
    if (state.legacy || input.rung !== state.hints.length)
      throw new ApiError('hint_history_gap', 'the preceding saved hints are unavailable', 409);
    const identity = {
      version: 1,
      request_id: input.requestId,
      binding_digest: binding,
      source_digest: sources,
      revision_id: coordinate.revision.revision_id,
      question_id: input.questionId,
      rung: input.rung,
      prior: state.hints.map((h) => ({ id: h.id, digest: h.publication.body_digest })),
    };
    await writeEvent(tx, {
      id,
      actor_kind: 'system',
      actor_ref: 'practice:hint',
      action: 'experimental:hint_generation_claim',
      subject_kind: 'issuance',
      subject_id: input.issuanceId,
      outcome: null,
      payload: { ...identity, input_digest: canonicalHash(identity) },
    });
    return { status: 'claimed' as const, prior: state.hints, claimId: id };
  });
}

export async function admitHintSend(
  db: Db,
  input: Coordinate & { rung: number; requestId: string },
) {
  return withStudyAuthorization(db, input, async (tx, _coordinate, binding, sources) => {
    const id = claimId(input, input.rung);
    const [claim] = await tx.select().from(event).where(eq(event.id, id));
    const [sent] = await tx
      .select()
      .from(event)
      .where(eq(event.id, `${id}:send`));
    if (
      !claim ||
      claim.payload.request_id !== input.requestId ||
      claim.payload.binding_digest !== binding ||
      claim.payload.source_digest !== sources ||
      sent
    )
      throw new ApiError('hint_outcome_unknown', 'send not authorized', 409);
    await writeEvent(tx, {
      id: `${id}:send`,
      actor_kind: 'system',
      actor_ref: 'practice:hint',
      action: 'experimental:hint_send_admission',
      subject_kind: 'issuance',
      subject_id: input.issuanceId,
      outcome: null,
      payload: { version: 1, claim_id: id },
    });
  });
}

export async function publishIssuedHint(
  db: Db,
  input: Coordinate & {
    rung: number;
    requestId: string;
    body: string;
    kind: HintPublicationT['kind'];
    disclosure?: string;
    receipt?: Record<string, unknown>;
    terminalFailure?: HelpProviderFault;
  },
) {
  if (!input.body || Buffer.byteLength(input.body) > 16384)
    throw new ApiError('hint_body_unsupported', 'hint body exceeds the publication boundary', 409);
  return withStudyAuthorization(db, input, async (tx, coordinate, binding, sources) => {
    const id = claimId(input, input.rung);
    const [claim] = await tx.select().from(event).where(eq(event.id, id));
    const [sent] = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, `${id}:send`));
    const state = await readHints(tx, input, binding, sources);
    if (
      input.kind === 'deterministic_next_step' &&
      sent &&
      !isHelpProviderFault(input.terminalFailure)
    )
      throw new ApiError(
        'hint_outcome_unknown',
        'the admitted provider attempt has no published reply; retry is disabled',
        409,
      );
    if (
      !claim ||
      (input.kind === 'ai' && !sent) ||
      claim.payload.request_id !== input.requestId ||
      claim.payload.source_digest !== sources ||
      claim.payload.binding_digest !== binding ||
      state.legacy ||
      state.hints.length !== input.rung
    )
      throw new ApiError('hint_publication_conflict', 'hint claim is no longer current', 409);
    const publication: HintPublicationT = {
      version: 1,
      binding_digest: binding,
      source_digest: sources,
      question_id: input.questionId,
      revision_id: coordinate.revision.revision_id,
      rung: input.rung,
      body: input.body,
      body_digest: canonicalHash(input.body),
      kind: input.kind,
      disclosure: input.disclosure ?? null,
      prior: state.hints.map((h) => ({ id: h.id, digest: h.publication.body_digest })),
      claim_id: id,
      request_id: input.requestId,
      source_exposure_id: null,
      receipt: input.terminalFailure
        ? { help_provider_fault: input.terminalFailure }
        : (input.receipt ?? null),
    };
    return recordStudyAssistanceExposure(tx, {
      ...input,
      kind: 'hint',
      impact: 'unknown',
      actorRef: 'assessment:assistance',
      contentDigest: `sha256:${publication.body_digest}`,
      dose: input.rung,
      eventId: exposureId(input, input.rung),
      publication,
    });
  });
}
