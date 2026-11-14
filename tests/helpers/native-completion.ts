import { readCompletionReceipt } from '@/capabilities/agency/server/learning-item-completion-policy';
import { commitFormalAttempt } from '@/capabilities/practice/grading/server/assessment/attempt';
import { setFixedAnchor } from '@/capabilities/practice/question-bank/server/fixed-anchor';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { withFencedNativeMasteryRead } from '@/kernel/read-models/native-mastery-basis';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { createKnowledgeNodeFromEvents } from '@/kernel/records/knowledge-node-birth';
import { createPendingLearningItem } from '@/kernel/records/learning-items';

export async function seedCompletionLearningItem(
  db: Db,
  itemId: string,
  sourceDocumentId?: string,
) {
  const now = new Date();
  const kc = `${itemId}-kc`;
  await db.transaction(async (tx) => {
    await createKnowledgeNodeFromEvents(
      tx,
      {
        id: kc,
        name: '合成加法',
        domain: 'math',
        parent_id: null,
        proposed_by_ai: false,
        created_at: now,
      },
      { actorRef: 'synthetic-fixture' },
    );
    await createPendingLearningItem(
      tx,
      {
        id: itemId,
        source: 'manual',
        source_ref: null,
        title: '合成完成计划',
        content: '',
        knowledge_ids: [kc],
        primary_artifact_id: null,
        parent_learning_item_id: null,
      },
      now,
    );
  });
  for (let i = 0; i < 5; i++) {
    const id = `${itemId}-q-${i}`;
    const [row] = await db
      .insert(question)
      .values({
        id,
        kind: 'choice',
        prompt_md: `${i}+2=?`,
        reference_md: 'B',
        choices_md: [`A. ${i + 1}`, `B. ${i + 2}`, `C. ${i + 3}`],
        knowledge_ids: [kc],
        source: 'manual',
        metadata: sourceDocumentId ? { source_document_id: sourceDocumentId } : {},
        difficulty: 3,
        draft_status: 'active',
        created_at: now,
        updated_at: now,
      })
      .returning();
    await setFixedAnchor(db, { questionId: id, bucket: 'medium' });
    const contract = normalizeQuestionRowToContract(row);
    const publication = await publishQuestionGroup(db, {
      group_id: id,
      contract,
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      claimPolicy: 'unbounded',
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'manual',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
      },
      actorRef: 'synthetic-fixture',
      now,
    });
    if (publication.status !== 'published') throw new Error('fixture publication failed');
    const when = new Date(now.getTime() - (i < 3 ? 2 : 1) * 86400000 + i * 60000);
    const issuance = await issueAssessment(db, { group_id: id, now: when });
    if (issuance.status !== 'issued') throw new Error('fixture issuance failed');
    const entries = contract.response_spec.slots.map((slot) => {
      if (slot.kind !== 'single_choice') throw new Error('unexpected fixture slot');
      return {
        slot_id: slot.slot_id,
        kind: 'choice' as const,
        option_ids: [slot.options[1].option_id],
      };
    });
    const settled = await commitFormalAttempt(
      db,
      'solo_submit',
      id,
      {
        issuance_id: issuance.issuance.issuance_id,
        evaluation_group_id: `${id}-attempt`,
        idempotency_key: `${id}-attempt`,
        response_set: { entries },
        now: when,
      },
      { capture: { response_md: 'B', hints_used: 0, final_hint_level: 0 } },
    );
    if (settled.status !== 'effective') throw new Error('fixture settlement failed');
  }
}

export async function seedCompletionProposal(db: Db, proposalId: string, itemId: string) {
  await db.transaction((tx) =>
    withFencedNativeMasteryRead(tx, async (reader) => {
      const receipt = await readCompletionReceipt(tx, reader, itemId);
      if (!receipt) throw new Error('native fixture is not completion eligible');
      await writeAiProposal(tx, {
        id: proposalId,
        actor_ref: 'synthetic-fixture',
        auto_apply_eligible: false,
        payload: {
          kind: 'completion',
          target: { subject_kind: 'learning_item', subject_id: itemId },
          reason_md: '合成证据达到门槛',
          evidence_refs: [],
          proposed_change: { learning_item_id: itemId, receipt },
        },
      });
    }),
  );
}
