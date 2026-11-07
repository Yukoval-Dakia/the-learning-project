// 受助事件 v2 / 封存收据 / evidence 分离的 DB 测试（db 分区；testcontainer + resetDb）。
// 断言契约：受助事件照实记 dose/phase；封存收据与 θ/FSRS/mastery 不被提交后揭示改写；
// 客户端自报洗不掉服务端受助事实；v1 事件永不升级为独立、永不伪造 max_dose。

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, mastery_state, material_fsrs_state } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { STUDY_ASSISTANCE_ACTION } from '@/kernel/records/study-reference';
import {
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { createAttempt } from '../api/submit';
import { readSubmissionAssistanceReceipt, recordAssistanceExposure } from './assessment/assistance';
import { revealFrozenStudyReference } from './assessment/study-context';

const HINT_DIGEST = `sha256:${'1'.repeat(64)}`;

async function exposuresFor(issuanceId: string) {
  return testDb()
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, STUDY_ASSISTANCE_ACTION),
        eq(event.subject_kind, 'issuance'),
        eq(event.subject_id, issuanceId),
      ),
    );
}

describe('assistance evidence separation', () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  // @invariant grading: a post-submit reference reveal records an
  // after_submit exposure but never rewrites the sealed submission receipt, the
  // attempt's θ/FSRS/mastery writes, or any learning state — the facts sealed at
  // submit time stay the settlement inputs
  // @fails-if the reveal event mutates the sealed receipt (status/max_dose/phase
  // drift), mints another submission event, or moves mastery_state /
  // material_fsrs_state rows after the commit
  it('seals the submission receipt at commit; post-submit reveal changes nothing', async () => {
    const db = testDb();
    const f = await nativeSoloHttpFixture(db);
    const issuanceId = f.body().assessment.issuance_id;

    const http = await createAttempt(nativeHttpRequest(f.body()));
    expect(http.status).toBe(200);
    const body = await http.json();
    expect(body).toMatchObject({
      status: 'effective',
      evidence: {
        assistance: {
          status: 'independent',
          max_dose: null,
          kinds: [],
          phase: 'before_submit',
        },
        verdict: { outcome: 'correct' },
      },
    });
    const submissionId = body.assessment.submission_id;
    const snapshot = async () => ({
      mastery: await db.select().from(mastery_state),
      fsrs: await db.select().from(material_fsrs_state),
      receipt: await readSubmissionAssistanceReceipt(db, submissionId),
      submissions: await db
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_submission')),
    });
    const before = await snapshot();
    expect(before.receipt).toMatchObject({
      status: 'independent',
      max_dose: null,
      kinds: [],
      phase: 'before_submit',
    });

    const reveal = await revealFrozenStudyReference(db, issuanceId);
    expect(reveal.reference_md).not.toBeNull();
    const exposures = await exposuresFor(issuanceId);
    expect(exposures).toHaveLength(1);
    expect(exposures[0].payload).toMatchObject({
      version: 2,
      kind: 'solution',
      impact: 'answer_help',
      dose: null,
      phase: 'after_submit',
    });

    expect(await snapshot()).toEqual(before);
  });

  // @invariant security: a submission following a server-recorded hint
  // exposure stays non-independent even when the request body reports nothing —
  // client capture fields can never launder a recorded exposure into independent
  // mastery evidence; the verdict still lands but θ/mastery abstains
  // @fails-if the response reports assistance.status 'independent', loses the
  // hint dose/kind, or the assisted attempt writes a mastery_state row
  it('keeps a recorded hint exposure non-independent on a clean-looking submit', async () => {
    const db = testDb();
    const f = await nativeSoloHttpFixture(db);
    const issuanceId = f.body().assessment.issuance_id;
    await recordAssistanceExposure(db, {
      issuanceId,
      questionId: f.id,
      kind: 'hint',
      impact: 'unknown',
      contentDigest: HINT_DIGEST,
      dose: 2,
    });

    const http = await createAttempt(nativeHttpRequest(f.body({ self_confidence: 5 })));
    expect(http.status).toBe(200);
    const body = await http.json();
    expect(body).toMatchObject({
      status: 'effective',
      evidence: {
        assistance: {
          status: 'unknown',
          max_dose: 2,
          kinds: ['hint'],
          phase: 'before_submit',
        },
        // The model still judged it correct — a correct answer with recorded
        // help is correct AND assisted, never independent.
        verdict: { outcome: 'correct' },
        self_claim: { confidence: 5 },
      },
    });
    // provenance.assisted reaches settlement as an abstain — the attempt is
    // scored and scheduled, but θ/mastery records no independent evidence.
    expect(await db.select().from(mastery_state)).toHaveLength(0);
    const receipt = await readSubmissionAssistanceReceipt(db, body.assessment.submission_id);
    expect(receipt).toMatchObject({
      status: 'unknown',
      max_dose: 2,
      kinds: ['hint'],
      phase: 'before_submit',
    });
    const exposures = await exposuresFor(issuanceId);
    expect(exposures).toHaveLength(1);
    expect(exposures[0].payload).toMatchObject({
      version: 2,
      kind: 'hint',
      dose: 2,
      phase: 'before_submit',
    });
  });

  // @invariant grading: a v1 assistance event carries no dose and no phase,
  // so its receipt can never read independent or fabricate a bounded max_dose —
  // historical evidence fails closed everywhere it is read
  // @fails-if a v1-only receipt reports status 'independent', a numeric max_dose,
  // or a provable phase, in either the sealed snapshot or the response evidence
  it('keeps v1 events unprovable for dose, phase and independence', async () => {
    const db = testDb();
    const f = await nativeSoloHttpFixture(db);
    const issuanceId = f.body().assessment.issuance_id;
    // harmless_clarification is the strictest fold: impact alone would read
    // independent, but a v1 row can never prove the exposure boundary.
    await writeEvent(db, {
      id: 'v1_hint_exposure',
      actor_kind: 'user',
      actor_ref: 'self',
      action: STUDY_ASSISTANCE_ACTION,
      subject_kind: 'issuance',
      subject_id: issuanceId,
      outcome: 'success',
      payload: {
        version: 1,
        kind: 'hint',
        impact: 'harmless_clarification',
        content_digest: HINT_DIGEST,
      },
      created_at: new Date(),
    });

    const http = await createAttempt(nativeHttpRequest(f.body()));
    expect(http.status).toBe(200);
    const body = await http.json();
    expect(body).toMatchObject({
      status: 'effective',
      evidence: {
        assistance: {
          status: 'unknown',
          max_dose: null,
          kinds: ['hint'],
          phase: null,
        },
      },
    });
    expect(await db.select().from(mastery_state)).toHaveLength(0);
    const receipt = await readSubmissionAssistanceReceipt(db, body.assessment.submission_id);
    expect(receipt).toMatchObject({
      status: 'unknown',
      max_dose: null,
      kinds: ['hint'],
      phase: null,
    });
  });
});
