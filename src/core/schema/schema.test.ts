// Phase 1c.1 Step 9.J — schema.test trimmed: tests for dropped tables
// (Mistake / ReviewEvent / IngestionSession / DreamingProposal) removed.
// Surviving tests cover the schemas that still exist post-DROP.

import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { parseEvent } from './event';
import {
  Artifact,
  CauseCategory,
  CauseSchema,
  FsrsState,
  KnowledgeInsert,
  LearningItemInsert,
  LearningRecord,
  LearningRecordInsert,
  MemoryBriefNote,
  MemoryBriefNoteInsert,
  NoteVerificationResult,
  QuestionBlock,
  QuestionBlockInsert,
  QuestionInsert,
  Rubric,
  SourceAsset,
  validateCauseAgainstProfile,
} from './index';

describe('schema generated from drizzle', () => {
  it('KnowledgeInsert accepts valid record', () => {
    const result = KnowledgeInsert.safeParse({
      id: 'k1',
      name: '宾语前置',
      domain: 'wenyan',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('CauseCategory accepts subject-specific cause ids with the shared id grammar', () => {
    const result = CauseCategory.safeParse('unit_error');
    expect(result.success).toBe(true);
  });

  it('Rubric accepts judge contract fields while preserving old criteria shape', () => {
    expect(
      Rubric.safeParse({
        criteria: [{ name: 'correctness', weight: 1, descriptor: '答出核心即可' }],
      }).success,
    ).toBe(true);

    const result = Rubric.safeParse({
      criteria: [{ name: 'correctness', weight: 1, descriptor: '覆盖所有要点' }],
      keywords: ['虚词', '代词'],
      acceptable_answers: ['代词'],
      required_points: ['指出它指代前文内容'],
    });
    expect(result.success).toBe(true);
  });

  it('QuestionInsert accepts teaching_check source', () => {
    const result = QuestionInsert.safeParse({
      id: 'q_teach',
      kind: 'short_answer',
      prompt_md: '这里的“之”指代什么？',
      reference_md: '之在这里作代词，指代前文的人或事。',
      source: 'teaching_check',
      source_ref: 'agent_msg_1',
      knowledge_ids: [],
      created_at: new Date(),
      updated_at: new Date(),
    });
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('CauseCategory rejects invalid cause id syntax', () => {
    const result = CauseCategory.safeParse('Unit Error');
    expect(result.success).toBe(false);
  });

  it('CauseSchema accepts syntactically valid cause ids; profile validation owns membership', () => {
    expect(
      CauseSchema.safeParse({
        primary_category: 'time_pressure',
        secondary_categories: ['unit_error'],
        analysis_md: '单位换算错误导致最终答案量纲不一致。',
        confidence: 0.8,
      }).success,
    ).toBe(true);
  });

  it('profile validation rejects causes outside the current SubjectProfile', () => {
    const parsed = CauseSchema.parse({
      primary_category: 'grammar',
      secondary_categories: ['unit_error', 'carelessness'],
      analysis_md: '语法错误不是数学 profile 的错因类目。',
      confidence: 0.8,
    });

    expect(validateCauseAgainstProfile(parsed, resolveSubjectProfile('math'))).toEqual({
      primary_category: 'other',
      secondary_categories: ['unit_error', 'carelessness'],
      analysis_md: '语法错误不是数学 profile 的错因类目。',
      confidence: 0.8,
    });
  });

  it('LearningItemInsert accepts minimal payload', () => {
    const result = LearningItemInsert.safeParse({
      id: 'li1',
      source: 'mistake',
      title: '宾语前置',
      created_at: new Date(),
      updated_at: new Date(),
    });
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('KnowledgeInsert accepts null domain (non-root nodes inherit)', () => {
    const result = KnowledgeInsert.safeParse({
      id: 'k_child',
      name: '通假字',
      domain: null,
      parent_id: 'k_root',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('SourceAsset accepts image metadata', () => {
    const result = SourceAsset.safeParse({
      id: 'asset_1',
      kind: 'image',
      storage_key: 'images/asset_1.png',
      mime_type: 'image/png',
      byte_size: 123,
      sha256: 'a'.repeat(64),
      width: null,
      height: null,
      provenance: {},
      created_at: new Date(1700000000 * 1000),
    });
    expect(result.success).toBe(true);
  });

  it('SourceAsset rejects unknown kind', () => {
    const result = SourceAsset.safeParse({
      id: 'asset_2',
      kind: 'video',
      storage_key: 'x',
      mime_type: 'video/mp4',
      byte_size: 1,
      sha256: 'a'.repeat(64),
      width: null,
      height: null,
      provenance: {},
      created_at: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('QuestionBlock accepts a single-page draft block', () => {
    const result = QuestionBlockInsert.safeParse({
      id: 'qb_1',
      ingestion_session_id: 'sess_1',
      source_document_id: 'doc_1',
      source_asset_ids: ['asset_1'],
      page_spans: [
        { page_index: 0, bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.3 }, role: 'prompt' },
      ],
      extracted_prompt_md: '题面',
      reference_md: null,
      wrong_answer_md: null,
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 0.9,
      status: 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_attempt_event_id: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('QuestionBlock accepts a merged cross-page block (page_spans length 2)', () => {
    const result = QuestionBlock.safeParse({
      id: 'qb_merged',
      ingestion_session_id: 'sess_1',
      source_document_id: 'doc_1',
      source_asset_ids: ['asset_1', 'asset_2'],
      page_spans: [
        { page_index: 0, bbox: { x: 0, y: 0.7, width: 1, height: 0.3 }, role: 'continuation' },
        { page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 0.4 }, role: 'answer_area' },
      ],
      extracted_prompt_md: '跨页题面',
      structured: null,
      figures: [],
      layout_quality: 'structured',
      reference_md: null,
      wrong_answer_md: '错答',
      image_refs: ['asset_1', 'asset_2'],
      crop_refs: [],
      visual_complexity: 'medium',
      extraction_confidence: 0.8,
      status: 'imported',
      knowledge_hint: null,
      merged_from_block_ids: ['qb_1', 'qb_2'],
      imported_question_id: null,
      imported_attempt_event_id: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page_spans).toHaveLength(2);
      expect(result.data.merged_from_block_ids).toEqual(['qb_1', 'qb_2']);
    }
  });

  it('FsrsState accepts ts-fsrs Card-aligned shape', () => {
    const result = FsrsState.safeParse({
      due: new Date(1700000000 * 1000),
      stability: 1.5,
      difficulty: 5.0,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state: 'review',
      last_review: new Date(1700000000 * 1000 - 86_400_000),
    });
    expect(result.success).toBe(true);
  });

  it('FsrsState rejects old shape (due_at / interval / ease)', () => {
    const result = FsrsState.safeParse({
      due_at: new Date(),
      interval: 1,
      ease: 2.5,
      repeat: 1,
      lapses: 0,
    });
    expect(result.success).toBe(false);
  });

  it('FsrsState coerces ISO string due (DB JSON round-trip path)', () => {
    const result = FsrsState.safeParse({
      due: '2026-05-10T00:00:00.000Z',
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state: 'learning',
      last_review: '2026-05-09T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.due).toBeInstanceOf(Date);
      expect(result.data.last_review).toBeInstanceOf(Date);
    }
  });

  it('LearningRecord accepts a mistake row linked to an attempt event', () => {
    const now = new Date();
    const result = LearningRecord.safeParse({
      id: 'lr1',
      kind: 'mistake',
      title: null,
      content_md: '错题摘要',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'attempt',
      processing_status: 'raw',
      origin_event_id: 'attempt1',
      subject_id: null,
      knowledge_ids: ['k1'],
      question_id: 'q1',
      attempt_event_id: 'attempt1',
      learning_item_id: null,
      artifact_id: null,
      source_document_id: null,
      asset_refs: [],
      payload: { wrong_answer_md: 'wrong' },
      created_at: now,
      updated_at: now,
      archived_at: null,
      version: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe('mistake');
  });

  it('LearningRecordInsert accepts a manual open question record', () => {
    const now = new Date();
    const result = LearningRecordInsert.safeParse({
      id: 'lr_open',
      kind: 'open_question',
      title: '辅助线疑问',
      content_md: '为什么这里要取中点？',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      processing_status: 'raw',
      origin_event_id: 'event_capture',
      knowledge_ids: [],
      payload: { question_md: '为什么这里要取中点？' },
      created_at: now,
      updated_at: now,
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('MemoryBriefNote accepts the three prose memory windows', () => {
    const now = new Date();
    const result = MemoryBriefNote.safeParse({
      id: 'mb1',
      scope_key: 'global',
      subject_id: null,
      recent_week_md: '本周主要在复习立体几何截面。',
      recent_months_md: '近几个月反复需要把定义、图形和证明步骤绑定起来。',
      long_term_md: '长期策略：先画图定位关系，再写证明。',
      recent_week_evidence_ids: ['event1', 'lr1'],
      recent_months_evidence_ids: ['event2'],
      long_term_evidence_ids: ['lr3'],
      source_event_id: 'event_refresh',
      latest_evidence_at: now,
      evidence_count: 3,
      refreshed_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('MemoryBriefNoteInsert accepts a global note draft', () => {
    const now = new Date();
    const result = MemoryBriefNoteInsert.safeParse({
      id: 'mb_insert',
      scope_key: 'global',
      subject_id: null,
      recent_week_md: '',
      recent_months_md: '',
      long_term_md: '',
      recent_week_evidence_ids: [],
      recent_months_evidence_ids: [],
      long_term_evidence_ids: [],
      source_event_id: null,
      latest_evidence_at: null,
      evidence_count: 0,
      refreshed_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('Artifact accepts runtime generation + verification statuses', () => {
    const now = new Date();
    const result = Artifact.safeParse({
      id: 'a1',
      type: 'note_atomic',
      title: '之的用法',
      parent_artifact_id: null,
      knowledge_ids: ['k1'],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: null,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: {
        verdict: 'pass',
        summary_md: '结构完整，未发现明显问题。',
        issues: [],
        confidence: 0.82,
      },
      generated_by: null,
      verified_by: { by: 'ai', task_kind: 'NoteVerifyTask' },
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
      embedded_check_status: 'not_required',
    });

    expect(result.success).toBe(true);
  });

  it('Artifact accepts runtime embedded_check_status values', () => {
    for (const status of ['not_required', 'pending', 'ready', 'failed'] as const) {
      const result = Artifact.safeParse({
        id: 'a1',
        type: 'note_atomic',
        title: '之的用法',
        parent_artifact_id: null,
        knowledge_ids: ['k1'],
        intent_source: 'learning_intent',
        source: 'ai_generated',
        source_ref: null,
        body_blocks: null,
        attrs: {},
        tool_kind: null,
        tool_state: null,
        generation_status: 'ready',
        verification_status: 'verified',
        verification_summary: {
          verdict: 'pass',
          summary_md: '结构完整，未发现明显问题。',
          issues: [],
          confidence: 0.82,
        },
        generated_by: null,
        verified_by: { by: 'ai', task_kind: 'NoteVerifyTask' },
        history: [],
        archived_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
        embedded_check_status: status,
      });
      expect(result.success, `status=${status}`).toBe(true);
    }
  });

  it('Artifact rejects unknown embedded_check_status', () => {
    const result = Artifact.safeParse({
      id: 'a1',
      type: 'note_atomic',
      title: '之的用法',
      parent_artifact_id: null,
      knowledge_ids: ['k1'],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: null,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: {
        verdict: 'pass',
        summary_md: '结构完整，未发现明显问题。',
        issues: [],
        confidence: 0.82,
      },
      generated_by: null,
      verified_by: { by: 'ai', task_kind: 'NoteVerifyTask' },
      history: [],
      archived_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
      embedded_check_status: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  it('NoteVerificationResult rejects invalid confidence', () => {
    const result = NoteVerificationResult.safeParse({
      verdict: 'pass',
      summary_md: 'ok',
      issues: [],
      confidence: 2,
    });

    expect(result.success).toBe(false);
  });

  it('parseEvent accepts record capture events', () => {
    const parsed = parseEvent({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:record_capture',
      subject_kind: 'record',
      subject_id: 'lr1',
      outcome: 'success',
      payload: {
        record_kind: 'open_question',
        activity_kind: 'ask',
        capture_mode: 'text',
        summary_md: 'Why does this proof work?',
      },
    });
    expect(parsed.action).toBe('experimental:record_capture');
  });

  it('parseEvent accepts memory brief refresh events', () => {
    const parsed = parseEvent({
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'experimental:memory_brief_refresh',
      subject_kind: 'memory_brief',
      subject_id: 'mb1',
      outcome: 'success',
      payload: {
        scope_key: 'global',
        changed_sections: ['recent_week', 'recent_months'],
        evidence_ids: ['event1', 'lr1'],
        previous_version: 0,
        next_version: 1,
      },
    });
    expect(parsed.action).toBe('experimental:memory_brief_refresh');
  });
});
