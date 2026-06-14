// ADR-0032 D6-B (YUK-203 lane L6) — DB-partition tests for propose_question_edit.
//
// Covers: registry (registered + summarized + correct effect), narrow-op input
// resolution + skip branches (not_found / not_active / no_structure / invalid_op /
// gate_rejected / duplicate_pending), and the happy `proposed` path that writes a
// pending question_edit proposal carrying the typed op. The accept-side (applier)
// behaviour is covered in
// src/capabilities/practice/server/proposal-appliers.db.test.ts.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { event, question } from '@/db/schema';
import { getProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import { proposeQuestionEditTool } from './proposal-tools';
import { __resetRegistryForTests, getTool } from './registry';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_yuk203_l6',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

function buildStructured(): StructuredQuestionT {
  return {
    id: 'n_stem',
    role: 'stem',
    prompt_text: '阅读下面文段，回答问题。',
    sub_questions: [
      {
        id: 'n_choice',
        role: 'sub',
        question_no: '1',
        prompt_text: '下列注音正确的一项是？',
        options: [
          { label: 'A', text: '甲' },
          { label: 'B', text: '乙' },
        ],
        answers: ['A'],
      },
      {
        id: 'n_short',
        role: 'sub',
        question_no: '2',
        prompt_text: '解释「之」的用法。',
        answers: ['代词。'],
        analysis: '此处作宾语。',
      },
    ],
  };
}

interface SeedOpts {
  id?: string;
  draftStatus?: string | null;
  structured?: StructuredQuestionT | null;
}

async function seedQuestion(opts: SeedOpts = {}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '阅读下面文段，回答问题。',
    reference_md: '代词。',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    draft_status: opts.draftStatus === undefined ? 'active' : opts.draftStatus,
    structured: opts.structured === undefined ? buildStructured() : opts.structured,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('propose_question_edit tool (ADR-0032 D6-B)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    __resetBootstrapForTests();
  });

  it('is registered with effect=propose and a summarizer', () => {
    registerCoreTools();
    const tool = getTool('propose_question_edit');
    expect(tool).toBeTruthy();
    expect(tool?.effect).toBe('propose');
    expect(proposeQuestionEditTool.costClass).toBe('local');
    const summary = proposeQuestionEditTool.summarize(
      { question_id: 'q1', op: 'edit_node_text', node_id: 'n_short' },
      { question_id: 'q1', op: 'edit_node_text', node_id: 'n_short', status: 'proposed' },
    );
    expect(summary).toContain('propose_question_edit');
    expect(summary).toContain('proposed');
  });

  it('proposes a typed edit_node_text op and writes a pending question_edit proposal', async () => {
    const id = await seedQuestion();
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_short',
      prompt_text: '解释「之」在此句中的具体用法。',
      reason: '题面表述不清',
    });
    expect(out.status).toBe('proposed');
    expect(out.proposal_id).toBeTruthy();
    expect(out.node_id).toBe('n_short');

    const row = await getProposalInboxRow(testDb(), out.proposal_id as string);
    expect(row?.kind).toBe('question_edit');
    expect(row?.status).toBe('pending');
    const change = row?.payload.proposed_change as {
      question_id?: string;
      edit?: { op?: string; node_id?: string; prompt_text?: string };
    };
    expect(change.question_id).toBe(id);
    expect(change.edit).toMatchObject({
      op: 'edit_node_text',
      node_id: 'n_short',
      prompt_text: '解释「之」在此句中的具体用法。',
    });
    // Evidence points at the question; NOTHING is written to the question row yet
    // (proposal-only — the active tree is unchanged until accept).
    const [q] = await testDb().select().from(question).where(eq(question.id, id));
    expect(q.version).toBe(0);
    const editRows = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_structure_edit'));
    expect(editRows).toHaveLength(0);
  });

  it('skips:not_found when the question row is missing', async () => {
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: 'q_gone',
      op: 'edit_node_text',
      node_id: 'n_stem',
      prompt_text: 'x',
    });
    expect(out.status).toBe('skipped:not_found');
    expect(out.proposal_id).toBeUndefined();
  });

  it('skips:not_active for a draft (non-pooled) question', async () => {
    const id = await seedQuestion({ draftStatus: 'draft' });
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_stem',
      prompt_text: 'x',
    });
    expect(out.status).toBe('skipped:not_active');
  });

  it('skips:no_structure when the active question has no structured tree', async () => {
    const id = await seedQuestion({ structured: null });
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_stem',
      prompt_text: 'x',
    });
    expect(out.status).toBe('skipped:no_structure');
  });

  it('skips:invalid_op when per-op fields are missing (edit_node_text without prompt_text)', async () => {
    const id = await seedQuestion();
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_short',
      // prompt_text omitted
    });
    expect(out.status).toBe('skipped:invalid_op');
  });

  it('skips:invalid_op for edit_reference with neither answers nor analysis', async () => {
    const id = await seedQuestion();
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_reference',
      node_id: 'n_short',
    });
    expect(out.status).toBe('skipped:invalid_op');
  });

  it('skips:gate_rejected when the node id does not exist in the tree', async () => {
    const id = await seedQuestion();
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_missing',
      prompt_text: 'x',
    });
    expect(out.status).toBe('skipped:gate_rejected');
    expect(out.gate_failure).toBe('node_not_found');
    // No proposal written for a doomed edit.
    const rows = await listProposalInboxRows(testDb(), { status: 'pending' });
    expect(rows.filter((r) => r.kind === 'question_edit')).toHaveLength(0);
  });

  it('skips:gate_rejected (not_a_leaf) when set_choice targets a stem node', async () => {
    const id = await seedQuestion();
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'set_choice',
      node_id: 'n_stem',
      options: [{ label: 'A', text: '甲' }],
    });
    expect(out.status).toBe('skipped:gate_rejected');
    expect(out.gate_failure).toBe('not_a_leaf');
  });

  it('skips:duplicate_pending for a second identical (question, node, op) edit', async () => {
    const id = await seedQuestion();
    const first = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_short',
      prompt_text: '第一版',
    });
    expect(first.status).toBe('proposed');
    const second = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'edit_node_text',
      node_id: 'n_short',
      prompt_text: '第二版',
    });
    expect(second.status).toBe('skipped:duplicate_pending');
    // Only one pending question_edit proposal for this node.
    const rows = await listProposalInboxRows(testDb(), { status: 'pending' });
    expect(rows.filter((r) => r.kind === 'question_edit')).toHaveLength(1);
  });

  it('proposes set_node_kind (advisory hint) on a leaf node', async () => {
    const id = await seedQuestion();
    const out = await proposeQuestionEditTool.execute(ctx(), {
      question_id: id,
      op: 'set_node_kind',
      node_id: 'n_choice',
      kind: 'choice',
    });
    expect(out.status).toBe('proposed');
    const row = await getProposalInboxRow(testDb(), out.proposal_id as string);
    const change = row?.payload.proposed_change as { edit?: { op?: string; kind?: string } };
    expect(change.edit).toMatchObject({ op: 'set_node_kind', kind: 'choice' });
  });
});
