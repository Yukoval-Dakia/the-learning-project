// YUK-214 (Strategy D · S1) — pure (no-DB) coverage for the ingest→practice
// paper builder. `buildIngestionPaperToolState` is a pure function over question
// rows → ToolStateT (§3.2). The DB writer (createIngestionPaper) + idempotency
// are covered by make-paper.db.test.ts (db partition). This file imports only
// the builder + Zod schema — zero DB import → unit partition (Cross-统合 F-12).

import { ToolState } from '@/core/schema/business';
import { describe, expect, it } from 'vitest';
import { type IngestionPaperQuestion, buildIngestionPaperToolState } from './make-paper';

function q(id: string, knowledgeIds: string[]): IngestionPaperQuestion {
  return { id, knowledge_ids: knowledgeIds };
}

describe('buildIngestionPaperToolState (YUK-214)', () => {
  it('builds one section, one assignment per question, in input order', () => {
    const ts = buildIngestionPaperToolState([q('q1', ['k1', 'k2']), q('q2', ['k3'])], {
      sessionId: 'sess_1',
      sourceDocumentId: 'doc_1',
    });

    expect(ts.question_ids).toEqual(['q1', 'q2']);
    expect(ts.sections).toHaveLength(1);
    expect(ts.sections?.[0].assignments).toHaveLength(2);
    expect(ts.sections?.[0].assignments.map((a) => a.question_id)).toEqual(['q1', 'q2']);
  });

  it('drives FSRS off knowledge_ids[0] (primary) with the rest as secondary', () => {
    const ts = buildIngestionPaperToolState([q('q1', ['k1', 'k2', 'k3'])], {
      sessionId: 'sess_1',
      sourceDocumentId: 'doc_1',
    });
    const a = ts.sections?.[0].assignments[0];
    expect(a?.primary_knowledge_id).toBe('k1');
    expect(a?.secondary_knowledge_ids).toEqual(['k2', 'k3']);
    expect(a?.selection_reason).toBe('ingested_paper');
  });

  it("uses feedback_policy='immediate' (imported papers are immediately visible)", () => {
    const ts = buildIngestionPaperToolState([q('q1', ['k1'])], {
      sessionId: 'sess_1',
      sourceDocumentId: 'doc_1',
    });
    expect(ts.sections?.[0].feedback_policy).toBe('immediate');
    expect(ts.sections?.[0].adaptation_policy).toBe('none');
  });

  it('collects the union of all knowledge_ids into knowledge_focus (deduped)', () => {
    const ts = buildIngestionPaperToolState([q('q1', ['k1', 'k2']), q('q2', ['k2', 'k3'])], {
      sessionId: 'sess_1',
      sourceDocumentId: 'doc_1',
    });
    expect(ts.sections?.[0].knowledge_focus).toEqual(['k1', 'k2', 'k3']);
  });

  it('threads ingestion provenance into session_meta', () => {
    const ts = buildIngestionPaperToolState([q('q1', ['k1'])], {
      sessionId: 'sess_42',
      sourceDocumentId: 'doc_42',
    });
    expect(ts.session_meta).toMatchObject({
      ingestion_session_id: 'sess_42',
      source_document_id: 'doc_42',
      tool_context_task_run_id: null,
    });
  });

  it('passes the ToolState Zod barrier (RL4)', () => {
    const ts = buildIngestionPaperToolState([q('q1', ['k1'])], {
      sessionId: 'sess_1',
      sourceDocumentId: 'doc_1',
    });
    expect(ToolState.safeParse(ts).success).toBe(true);
  });

  it('rejects an empty question set (no empty papers)', () => {
    expect(() =>
      buildIngestionPaperToolState([], { sessionId: 'sess_1', sourceDocumentId: 'doc_1' }),
    ).toThrow(/at least one question/i);
  });

  it('rejects a question with no knowledge_ids (primary would be undefined)', () => {
    expect(() =>
      buildIngestionPaperToolState([q('q1', [])], {
        sessionId: 'sess_1',
        sourceDocumentId: 'doc_1',
      }),
    ).toThrow(/knowledge_id/i);
  });
});
