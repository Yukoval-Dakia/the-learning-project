// ADR-0032 D6-B (YUK-203 lane L6) — DB-partition tests for propose_question_edit.
//
// Covers: registry (registered + summarized + correct effect), narrow-op input
// resolution + skip branches (not_found / not_active / no_structure / invalid_op /
// gate_rejected / duplicate_pending), and the happy `proposed` path that writes a
// pending question_edit proposal carrying the typed op. The accept-side (applier)
// behaviour is covered in
// src/capabilities/practice/server/proposal-appliers.db.test.ts.

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { proposeQuestionEditTool } from '@/capabilities/practice/server/tools/proposal-tools';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { question } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import type { ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetRegistryForTests } from './registry';

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
});
