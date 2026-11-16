// Temporary YUK-1886 dev-stack verification driver — seeds a real conjecture probe
// and a real ingestion capture fixture against the dev database, then exercises the
// kernel/judge port operations the API route will call. Deleted after the run; the
// evidence lives in the command transcript.
import { eq } from 'drizzle-orm';
import {
  captureIngestionOriginal,
  enrollNativeCapture,
} from '@/capabilities/ingestion/server/assessment-capture';
import { installPracticeHost } from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import { ConjectureProposalChange } from '@/core/schema/proposal';
import { db } from '@/db/client';
import {
  event,
  knowledge,
  learning_session,
  question,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { saveSubmission } from '@/kernel/judge';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { probeContainerRef, probeIssuanceId } from '@/kernel/read-models/probe-delivery';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { seedHistoricalAssessmentIssuance } from '../tests/fixtures/historical-assessment-issuance';

const KC = 'kc_yuk1886_dev_probe';
const CAPTURE_KC = 'kc_yuk1886_dev_capture';
const PROBE_MD = 'Compute 6 groups of 7 objects (dev verification probe).';
const PROBE_REFERENCE = '42';
const now = new Date();

// --- 0) Fail-fast check: an uninstalled port call must throw before we install.
try {
  await saveSubmission(db, {
    issuance_id: 'iss_nonexistent',
    evaluation_group_id: 'eg_none',
    submission_id: 'sub_none',
    idempotency_key: 'k',
    response_set: { entries: [] },
    group_evidence: [],
    actorRef: 'yuk1886:uninstalled-check',
  });
  console.log('FAILFAST: unexpected success');
} catch (err) {
  console.log(
    `FAILFAST: ${err instanceof Error ? err.constructor.name : typeof err} — ${
      err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
    }`,
  );
}

await installPracticeHost();
console.log('installPracticeHost: done');

// --- 1) Probe fixture: knowledge + accepted conjecture proposal + admitted probe.
await db
  .insert(knowledge)
  .values({ id: KC, name: '整数计算 dev', domain: 'math', created_at: now, updated_at: now })
  .onConflictDoNothing();

const change = ConjectureProposalChange.parse({
  claim_md: 'dev verification conjecture',
  knowledge_id: KC,
  cause_category: 'concept_misunderstanding',
  confidence: 0.7,
  recurrence_count: 2,
  probe_md: PROBE_MD,
  probe_reference_md: PROBE_REFERENCE,
  discriminating: true,
  predicted_p: 0.3,
  baseline_p_at_induction: 0.6,
});
const proposalId = await writeAiProposal(db, {
  actor_ref: 'research_meeting',
  payload: {
    kind: 'conjecture',
    target: { subject_kind: 'mind_model', subject_id: KC },
    reason_md: 'dev verification',
    evidence_refs: [{ kind: 'event', id: 'evt_yuk1886_dev' }],
    cooldown_key: `conjecture:${KC}`,
    proposed_change: change,
  },
});
await writeEvent(db, {
  id: `rate_${proposalId}`,
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'rate',
  subject_kind: 'event',
  subject_id: proposalId,
  outcome: 'success',
  payload: { rating: 'accept', conjecture_id: proposalId, calibration_anchor: 'accept' },
  caused_by_event_id: proposalId,
});

const probeQuestionId = newId();
await db.insert(question).values(
  withAnswerClass({
    id: probeQuestionId,
    kind: 'short_answer',
    version: 0,
    prompt_md: PROBE_MD,
    reference_md: PROBE_REFERENCE,
    knowledge_ids: [KC],
    difficulty: 3,
    judge_kind_override: 'multimodal_direct',
    source: 'mind_probe',
    source_ref: proposalId,
    draft_status: 'draft',
    metadata: { conjecture_proposal_id: proposalId, probe_sequence: 1 },
    created_at: now,
    updated_at: now,
  }),
);
const published = await publishQuestionGroupFromRow(db, {
  rootId: probeQuestionId,
  claimPolicy: 'one_time',
  availability: 'container_only',
  actorRef: 'yuk1886:dev-verify',
  now,
  admission: {
    state: 'admitted',
    evidence: {
      marking_provenance: 'official',
      verification: { structural_check_passed: true, independent_verification: null },
      model_slice: null,
    },
  },
});
console.log(`probe publish: ${published.status}`);
const issued = await seedHistoricalAssessmentIssuance(db, {
  group_id: probeQuestionId,
  issuance_id: probeIssuanceId(probeQuestionId),
  container_occurrence_ref: probeContainerRef(probeQuestionId),
  actorRef: 'yuk1886:dev-verify',
});
console.log(`probe issuance: ${JSON.stringify(issued.issuance?.issuance_id ?? issued)}`);

// --- 2) Capture fixture: ingestion session + draft block with a wrong answer.
await db
  .insert(knowledge)
  .values({ id: CAPTURE_KC, name: 'capture dev', domain: 'math', created_at: now, updated_at: now })
  .onConflictDoNothing();
await db
  .insert(source_asset)
  .values({
    id: 'yuk1886-capture-page',
    kind: 'image',
    storage_key: 'offline/page',
    mime_type: 'image/png',
    byte_size: 4096,
    sha256: 'b'.repeat(64),
    created_at: now,
  })
  .onConflictDoNothing();
await db
  .insert(source_document)
  .values({
    id: 'yuk1886-capture-document',
    source_asset_ids: ['yuk1886-capture-page'],
    provenance: { usage_policy: { derivation_policy: 'allow' } },
    created_at: now,
    updated_at: now,
    version: 0,
  })
  .onConflictDoNothing();
await db
  .insert(learning_session)
  .values({
    id: 'yuk1886-capture-session',
    type: 'ingestion',
    status: 'extracted',
    entrypoint: 'vision_paper',
    source_document_id: 'yuk1886-capture-document',
    source_asset_ids: ['yuk1886-capture-page'],
    created_at: now,
    updated_at: now,
    version: 0,
  })
  .onConflictDoNothing();
const [block] = await db
  .insert(question_block)
  .values({
    id: `yuk1886-capture-block-${Date.now()}`,
    ingestion_session_id: 'yuk1886-capture-session',
    extracted_prompt_md: 'How many objects in 6 groups of 7?',
    structured: {
      id: 'yuk1886-capture-part',
      role: 'standalone',
      source: 'vlm_structure',
      prompt_text: 'How many objects in 6 groups of 7?',
    },
    reference_md: '42',
    wrong_answer_md: '42',
    source_asset_ids: ['yuk1886-capture-page'],
    figures: [],
    image_refs: [],
    status: 'draft',
    extraction_confidence: 1,
    created_at: now,
    updated_at: now,
    version: 0,
  })
  .returning();
const input = {
  block,
  knowledgeIds: [CAPTURE_KC],
  difficulty: 3,
  confidence: 1,
  canEnroll: true,
  pageRefs: ['yuk1886-capture-page'],
  now,
};
const capture = await captureIngestionOriginal(db, input);
console.log(`capture: question=${capture?.questionId} admitted=${capture?.admitted}`);
if (!capture) throw new Error('capture returned null');
const admitted = await publishQuestionGroupFromRow(db, {
  rootId: capture.questionId,
  actorRef: 'yuk1886:dev-capture-admission',
  now,
  admission: {
    state: 'admitted',
    evidence: {
      marking_provenance: 'official',
      verification: { structural_check_passed: true, independent_verification: null },
      model_slice: null,
    },
  },
});
console.log(`capture admission: ${admitted.status}`);
const enrolled = await enrollNativeCapture(db, input);
console.log(`enrolled: ${JSON.stringify(enrolled)}`);

const [attempt] = await db
  .select({ id: event.id, action: event.action })
  .from(event)
  .where(eq(event.id, enrolled?.attempt_event_id ?? 'none'));
console.log(`attempt event: ${JSON.stringify(attempt)}`);

console.log(`SEED_DONE probe=${probeQuestionId} session=yuk1886-capture-session block=${block.id}`);
process.exit(0);
