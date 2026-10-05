import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import type { ResponseSpecT, SlotResponseT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { question, question_group_lifecycle } from '@/db/schema';
import { normalizeQuestionRowToContract } from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { publishPaperModelFixture } from './assessment-paper';

/** Publish before issue, then retain this original across retries and current-row edits. */
export async function issueSoloFixture(db: Db, questionId: string, model = false) {
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, questionId));
  if (!lifecycle?.current_revision_id) {
    if (model) await publishPaperModelFixture(db, questionId);
    else {
      const [row] = await db.select().from(question).where(eq(question.id, questionId));
      if (!row) throw new Error('solo fixture question missing');
      const result = await publishQuestionGroup(db, {
        group_id: questionId,
        contract: normalizeQuestionRowToContract(row),
        expectedCurrentRevision: null,
        expectedAdmissionGeneration: null,
        availability: 'general_pool',
        actorRef: 'test:solo-publication',
        now: new Date(),
        admission: {
          state: 'admitted',
          evidence: {
            marking_provenance: 'official',
            verification: { structural_check_passed: true, independent_verification: null },
            model_slice: null,
          },
        },
      });
      if (result.status !== 'published') throw new Error(result.status);
    }
  }
  const issued = await issueAssessment(db, { group_id: questionId });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const ids = {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: `test_solo_group_${createId()}`,
    idempotency_key: `test_solo_key_${createId()}`,
  };
  return {
    ...issued,
    assessment: (text: string) => ({
      ...ids,
      response_set: { entries: [soloFixtureResponse(issued.practice_dto.response_spec, text)] },
      group_evidence: [],
    }),
  };
}

function soloFixtureResponse(spec: ResponseSpecT, text: string): SlotResponseT {
  const slots = spec.slots.filter((slot) => slot.kind !== 'table');
  if (slots.length !== 1)
    throw new Error('solo fixture requires an explicit response for multiple slots');
  const slot = slots[0];
  switch (slot.kind) {
    case 'text':
      return { slot_id: slot.slot_id, kind: 'text', text_md: text };
    case 'open_response':
      return { slot_id: slot.slot_id, kind: 'open', text_md: text, evidence: [] };
    case 'single_choice':
    case 'multi_choice': {
      const options = slot.options.filter(
        (option) => option.label === text || option.text === text,
      );
      if (text && options.length !== 1)
        throw new Error('response must identify a published option');
      return {
        slot_id: slot.slot_id,
        kind: 'choice',
        option_ids: options.map((option) => option.option_id),
      };
    }
    case 'numeric':
      return {
        slot_id: slot.slot_id,
        kind: 'numeric',
        raw_input: text,
        value: text.trim() && Number.isFinite(Number(text)) ? Number(text) : null,
      };
    case 'formula':
      return { slot_id: slot.slot_id, kind: 'formula', latex: text };
    default:
      throw new Error(`fixture requires an explicit native response for ${slot.kind}`);
  }
}
