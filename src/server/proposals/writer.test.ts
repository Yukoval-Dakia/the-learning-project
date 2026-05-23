import type { AiProposalPayloadInputT } from '@/core/schema/proposal';
import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { writeAiProposal } from './writer';

const base = {
  reason_md: 'Evidence supports this proposal.',
  evidence_refs: [{ kind: 'event' as const, id: 'attempt_1' }],
  rollback_plan: { action: 'write correction event' },
};

describe('writeAiProposal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a knowledge_node proposal with legacy KnownEvent fields plus ai_proposal', async () => {
    const db = testDb();
    const id = await writeAiProposal(db, {
      actor_ref: 'dreaming',
      outcome: 'partial',
      task_run_id: 'run_node',
      cost_usd: 0.012345,
      payload: {
        ...base,
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'seed:wenyan:shici',
        },
        cooldown_key: 'knowledge_node:seed:wenyan:shici:通假字',
      },
    });

    const row = (await db.select().from(event).where(eq(event.id, id)))[0];
    expect(row.action).toBe('propose');
    expect(row.subject_kind).toBe('knowledge');
    expect(row.outcome).toBe('partial');
    expect(row.actor_ref).toBe('dreaming');
    expect(row.task_run_id).toBe('run_node');
    expect(row.cost_micro_usd).toBe(12345);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.name).toBe('通假字');
    expect(payload.parent_id).toBe('seed:wenyan:shici');
    expect(payload.reasoning).toBe(base.reason_md);
    expect((payload.ai_proposal as { kind?: string }).kind).toBe('knowledge_node');
  });

  it('writes a knowledge_edge proposal with legacy KnownEvent fields plus ai_proposal', async () => {
    const db = testDb();
    const id = await writeAiProposal(db, {
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: {
        ...base,
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 0.7,
        },
        cooldown_key: 'knowledge_edge:k1:k2:prerequisite',
      },
    });

    const row = (await db.select().from(event).where(eq(event.id, id)))[0];
    expect(row.action).toBe('propose');
    expect(row.subject_kind).toBe('knowledge_edge');
    expect(row.outcome).toBe('success');
    const payload = row.payload as Record<string, unknown>;
    expect(payload.from_knowledge_id).toBe('k1');
    expect(payload.to_knowledge_id).toBe('k2');
    expect(payload.relation_type).toBe('prerequisite');
    expect(payload.weight).toBe(0.7);
    expect(payload.reasoning).toBe(base.reason_md);
    expect((payload.ai_proposal as { kind?: string }).kind).toBe('knowledge_edge');
  });

  it('accepts every proposal kind through the shared writer', async () => {
    const db = testDb();
    const samples: AiProposalPayloadInputT[] = [
      {
        ...base,
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        proposed_change: { mutation: 'propose_new', name: '节点', parent_id: 'parent_1' },
      },
      {
        ...base,
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 0.5,
        },
      },
      {
        ...base,
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        proposed_change: { title: '复习路径' },
      },
      {
        ...base,
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'artifact_1' },
        proposed_change: { artifact_id: 'artifact_1', patch_md: 'Add note.' },
      },
      {
        ...base,
        kind: 'variant_question',
        target: { subject_kind: 'question', subject_id: 'question_1' },
        proposed_change: { source_question_id: 'question_1', prompt_md: 'Variant' },
      },
      {
        ...base,
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'item_1' },
        proposed_change: { completed_at: '2026-05-23T00:00:00.000Z' },
      },
      {
        ...base,
        kind: 'relearn',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: { knowledge_id: 'k1', priority: 'high' },
      },
      {
        ...base,
        kind: 'archive',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: { subject_kind: 'knowledge', subject_id: 'k1', reason_md: 'Duplicate' },
      },
      {
        ...base,
        kind: 'judge_retraction',
        target: { subject_kind: 'event', subject_id: 'judge_1' },
        proposed_change: { judge_event_id: 'judge_1', reason_md: 'Wrong judge.' },
      },
    ];

    for (const sample of samples) {
      await writeAiProposal(db, { payload: sample });
    }

    const rows = await db.select().from(event);
    expect(rows).toHaveLength(9);
    const experimentalRows = rows.filter((row) => row.action === 'experimental:proposal');
    expect(experimentalRows).toHaveLength(7);
    expect(
      rows
        .map(
          (row) => ((row.payload as Record<string, unknown>).ai_proposal as { kind: string }).kind,
        )
        .sort(),
    ).toEqual(samples.map((sample) => sample.kind).sort());
  });
});
