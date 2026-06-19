import {
  artifact,
  completion_evidence,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  material_fsrs_state,
  memory_brief_note,
  question,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import {
  getLearningItemContextTool,
  getQuestionContextTool,
  getRecordContextTool,
  getReviewDueTool,
  queryMemoryBriefTool,
  queryRecordsTool,
} from './context-readers';
import {
  expandKnowledgeSubgraphTool,
  findKnowledgePathsTool,
  getSubjectGraphOverviewTool,
  queryKnowledgeTool,
} from './knowledge-readers';
import { __resetRegistryForTests, getTool, listTools } from './registry';
import type { ToolContext } from './types';

const BASE = new Date(Date.now() - 60_000);

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_td2',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

function fsrsState(due: Date) {
  return {
    due: due.toISOString(),
    stability: 2,
    difficulty: 5,
    elapsed_days: 1,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 'review',
    last_review: BASE.toISOString(),
  };
}

async function seedGraph() {
  const db = testDb();
  await db.insert(knowledge).values([
    {
      id: 'k_root',
      name: '文言虚词',
      domain: 'wenyan',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_zhi',
      name: '之的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_er',
      name: '而的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
  await db.insert(knowledge_edge).values({
    id: 'edge_zhi_er',
    from_knowledge_id: 'k_zhi',
    to_knowledge_id: 'k_er',
    relation_type: 'contrasts_with',
    weight: 0.8,
    created_by: 'user' as never,
    reasoning: '二者常在断句和翻译里混淆',
    created_at: BASE,
  });
}

async function seedQuestionsAndEvents() {
  const db = testDb();
  await db.insert(question).values([
    {
      id: 'q_new',
      kind: 'short_answer',
      prompt_md: '解释「之」在句中的作用',
      reference_md: '结构助词，取消句子独立性。',
      source: 'manual',
      knowledge_ids: ['k_zhi'],
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'q_due',
      kind: 'short_answer',
      prompt_md: '比较「之」与「而」的用法',
      reference_md: '前者多作助词，后者多表承接或转折。',
      source: 'manual',
      knowledge_ids: ['k_zhi', 'k_er'],
      created_at: new Date(BASE.getTime() + 1_000),
      updated_at: BASE,
    },
  ]);
  await writeEvent(db, {
    id: 'att_new',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_new',
    outcome: 'failure',
    payload: {
      answer_md: '把之理解成代词',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_zhi'],
    },
    created_at: new Date(BASE.getTime() + 2_000),
  });
  await writeEvent(db, {
    id: 'judge_new',
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'AttributionTask',
    action: 'judge',
    subject_kind: 'event',
    subject_id: 'att_new',
    outcome: 'success',
    caused_by_event_id: 'att_new',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: ['method'],
        analysis_md: '混淆助词与代词',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['k_zhi'],
    },
    created_at: new Date(BASE.getTime() + 3_000),
  });
  await writeEvent(db, {
    id: 'review_due',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: 'q_due',
    outcome: 'success',
    payload: {
      fsrs_rating: 'good',
      fsrs_state_after: fsrsState(new Date(BASE.getTime() - 86_400_000)),
      user_response_md: null,
      referenced_knowledge_ids: ['k_zhi', 'k_er'],
    },
    created_at: new Date(BASE.getTime() + 4_000),
  });
  await db.insert(material_fsrs_state).values({
    id: 'fsrs_due',
    subject_kind: 'knowledge',
    subject_id: 'k_er',
    state: fsrsState(new Date(BASE.getTime() - 86_400_000)) as never,
    due_at: new Date(BASE.getTime() - 86_400_000),
    last_review_event_id: 'review_due',
    updated_at: BASE,
  });
}

async function seedLearningObjects() {
  const db = testDb();
  await db.insert(artifact).values({
    id: 'art_note',
    type: 'note',
    title: '之的用法笔记',
    knowledge_ids: ['k_zhi'],
    intent_source: 'learning_intent',
    source: 'agent',
    source_ref: 'seed',
    generation_status: 'ready',
    body_blocks: {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'b1', semantic_kind: 'concept', title: '核心概念' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '之可作结构助词。' }] }],
        },
      ],
    } as never,
    created_at: BASE,
    updated_at: BASE,
  });
  await db.insert(learning_item).values([
    {
      id: 'li_parent',
      source: 'manual',
      title: '文言虚词总览',
      content: '总览',
      status: 'in_progress',
      knowledge_ids: ['k_root'],
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'li_zhi',
      source: 'manual',
      title: '学习之的用法',
      content: '先看例句，再做题。',
      status: 'in_progress',
      knowledge_ids: ['k_zhi'],
      primary_artifact_id: 'art_note',
      parent_learning_item_id: 'li_parent',
      created_at: new Date(BASE.getTime() + 1_000),
      updated_at: BASE,
    },
  ]);
  await db.insert(completion_evidence).values({
    id: 'ev_complete',
    learning_item_id: 'li_zhi',
    path: 'primary_artifact.ready',
    evidence_json: { summary: 'note ready' },
    decided_at: new Date(BASE.getTime() + 2_000),
  });
  await db.insert(learning_record).values({
    id: 'rec_mistake',
    kind: 'mistake',
    title: '之的误判',
    content_md: '我把结构助词误判成代词。',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'attempt',
    processing_status: 'linked',
    origin_event_id: 'att_new',
    subject_id: 'wenyan',
    knowledge_ids: ['k_zhi'],
    question_id: 'q_new',
    attempt_event_id: 'att_new',
    learning_item_id: 'li_zhi',
    artifact_id: 'art_note',
    created_at: new Date(BASE.getTime() + 3_000),
    updated_at: BASE,
  });
}

async function seedMemoryBrief() {
  await testDb()
    .insert(memory_brief_note)
    .values({
      id: 'mb_global',
      scope_key: 'global',
      subject_id: null,
      recent_week_md: '本周常错虚词「之」。',
      recent_months_md: '近月重点是文言翻译。',
      long_term_md: '适合先辨析再刷题。',
      recent_week_evidence_ids: ['rec_mistake'],
      recent_months_evidence_ids: ['att_new'],
      long_term_evidence_ids: ['k_zhi'],
      source_event_id: 'evt_item',
      latest_evidence_at: BASE,
      evidence_count: 3,
      refreshed_at: new Date(BASE.getTime() + 5_000),
      created_at: BASE,
      updated_at: BASE,
    });
}

async function seedAll() {
  await seedGraph();
  await seedQuestionsAndEvents();
  await seedLearningObjects();
  await seedMemoryBrief();
}

describe('Foundation D M2 read tools', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    __resetBootstrapForTests();
  });

  it('registerCoreTools exposes M1 readers plus all 10 M2 readers', () => {
    registerCoreTools();
    expect(getTool('query_mistakes')).toBeTruthy();
    expect(getTool('get_attempt_context')).toBeTruthy();
    expect(
      listTools({ effect: 'read' })
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      'expand_knowledge_subgraph',
      'find_knowledge_paths',
      'get_attempt_context',
      'get_learning_item_context',
      // ADR-0032 D6-draftread (YUK-203 lane L5) — ingestion draft-layer structure reader.
      'get_question_block_structure',
      'get_question_context',
      'get_record_context',
      'get_review_due',
      // YUK-203 U4 — ReviewPlanTask read tools + Mem0 fact search.
      'get_review_knowledge_snapshot',
      'get_subject_graph_overview',
      'query_events',
      'query_knowledge',
      'query_memory_brief',
      'query_mistakes',
      // ADR-0032 D9 / YUK-304 — questions catalog reader (wraps the YUK-280 list reader).
      'query_questions',
      'query_records',
      'read_coach_brief',
      'search_memory_facts',
      'select_review_question_candidates',
    ]);
  });

  it('reads graph overview, local nodes, subgraph, and path explanations', async () => {
    await seedAll();

    const overview = await getSubjectGraphOverviewTool.execute(ctx(), { subjectId: 'wenyan' });
    expect(overview.root_nodes).toEqual([{ id: 'k_root', name: '文言虚词' }]);
    expect(overview.clusters[0].edge_count).toBe(1);

    const overviewWithWeakness = await getSubjectGraphOverviewTool.execute(ctx(), {
      subjectId: 'wenyan',
      includeWeaknessSummary: true,
    });
    expect(overviewWithWeakness.clusters[0].recent_failure_count_30d).toBe(1);

    const knowledgeRows = await queryKnowledgeTool.execute(ctx(), {
      subjectId: 'wenyan',
      query: '之',
      include: ['neighbors', 'recent_failures'],
    });
    expect(knowledgeRows.nodes[0].id).toBe('k_zhi');
    expect(knowledgeRows.nodes[0].path).toEqual(['文言虚词', '之的用法']);
    expect(knowledgeRows.nodes.map((node) => node.id)).toEqual(['k_zhi', 'k_er']);
    expect(knowledgeRows.recent_failures?.[0].event_id).toBe('att_new');

    const expandedQuery = await queryKnowledgeTool.execute(ctx(), {
      subjectId: 'wenyan',
      nodeId: 'k_zhi',
      include: ['ancestors', 'neighbors', 'stats'],
    });
    expect(expandedQuery.nodes.map((node) => node.id)).toEqual(['k_zhi', 'k_root', 'k_er']);
    expect(expandedQuery.nodes[0].stats?.recent_failure_count_30d).toBe(1);

    const subgraph = await expandKnowledgeSubgraphTool.execute(ctx(), {
      centerNodeId: 'k_zhi',
      depth: 1,
      include: ['ancestors', 'neighbors', 'recent_failures'],
    });
    expect(subgraph.nodes.map((node) => node.id).sort()).toEqual(['k_er', 'k_root', 'k_zhi']);
    expect(subgraph.edges[0].relation_type).toBe('contrasts_with');

    await testDb().insert(knowledge).values({
      id: 'k_archived',
      name: '旧节点',
      domain: null,
      parent_id: 'k_root',
      archived_at: BASE,
      created_at: BASE,
      updated_at: BASE,
    });
    await testDb()
      .insert(knowledge_edge)
      .values({
        id: 'edge_archived',
        from_knowledge_id: 'k_zhi',
        to_knowledge_id: 'k_archived',
        relation_type: 'related_to',
        weight: 0.1,
        created_by: 'user' as never,
        created_at: BASE,
      });
    const subgraphWithArchivedEdge = await expandKnowledgeSubgraphTool.execute(ctx(), {
      centerNodeId: 'k_zhi',
      include: ['neighbors'],
    });
    expect(subgraphWithArchivedEdge.nodes.map((node) => node.id)).not.toContain('k_archived');

    const paths = await findKnowledgePathsTool.execute(ctx(), {
      fromKnowledgeId: 'k_zhi',
      toKnowledgeId: 'k_er',
    });
    expect(paths.paths[0].node_ids).toEqual(['k_zhi', 'k_er']);
    expect(paths.paths[0].edge_types).toEqual(['contrasts_with']);
  });

  it('reads records, record context, and question context', async () => {
    await seedAll();

    const records = await queryRecordsTool.execute(ctx(), {
      kind: ['mistake'],
      knowledgeIds: ['k_zhi'],
    });
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0].links.attempt_event_id).toBe('att_new');

    const recordContext = await getRecordContextTool.execute(ctx(), {
      recordId: 'rec_mistake',
      include: [
        'question',
        'attempt',
        'attribution',
        'artifact',
        'learning_item',
        'knowledge_context',
        'event_chain',
      ],
    });
    expect(recordContext.record?.kind).toBe('mistake');
    expect(recordContext.question?.id).toBe('q_new');
    expect(recordContext.attribution?.chosen_source).toBe('judge');
    expect(recordContext.artifact?.summary).toContain('concept');
    expect(recordContext.knowledge_context?.paths[0]).toEqual(['文言虚词', '之的用法']);

    const questionContext = await getQuestionContextTool.execute(ctx(), {
      questionId: 'q_new',
      include: ['attempts', 'records', 'knowledge_context'],
    });
    expect(questionContext.question?.id).toBe('q_new');
    expect(questionContext.lifecycle.attempt_counts.failure).toBe(1);
    expect(questionContext.records?.[0].record_id).toBe('rec_mistake');
  });

  // ADR-0032 D6-R6 — get_question_context(include:['structure']) projects the
  // addressable StructuredQuestion tree (read≡write coordinate fix) clipped to
  // id/role/sub_questions + figure addressing.
  it('projects the addressable structure tree on include:[structure]', async () => {
    const db = testDb();
    const bbox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    await db.insert(question).values({
      id: 'q_structured',
      kind: 'short_answer',
      prompt_md: '阅读文段，回答问题。',
      reference_md: null,
      source: 'manual',
      knowledge_ids: [],
      structured: {
        id: 'stem_1',
        role: 'stem',
        prompt_text: '阅读文段。',
        bbox,
        page_index: 0,
        source: 'vlm_structure',
        sub_questions: [{ id: 'sub_1', role: 'sub', prompt_text: '解释加点字。', bbox }],
      },
      figures: [
        {
          asset_id: 'asset_a',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: bbox,
          attached_to_index: 'sub_1',
          attach_confidence: 'high',
        },
      ],
      created_at: BASE,
      updated_at: BASE,
    });

    const withStructure = await getQuestionContextTool.execute(ctx(), {
      questionId: 'q_structured',
      include: ['structure'],
    });
    expect(withStructure.structure?.tree.id).toBe('stem_1');
    expect(withStructure.structure?.tree.sub_questions?.[0].id).toBe('sub_1');
    expect(withStructure.structure?.tree).not.toHaveProperty('bbox');
    expect(withStructure.structure?.tree).not.toHaveProperty('page_index');
    expect(withStructure.structure?.figures).toEqual([
      { asset_id: 'asset_a', role: 'diagram', attached_to_index: 'sub_1' },
    ]);

    // Not requested → no structure key (and a non-structured question yields none).
    const withoutStructure = await getQuestionContextTool.execute(ctx(), {
      questionId: 'q_structured',
      include: ['attempts'],
    });
    expect(withoutStructure.structure).toBeUndefined();
  });

  it('reads due queue, learning item context, and memory brief', async () => {
    await seedAll();

    const due = await getReviewDueTool.execute(ctx(), { limit: 10 });
    expect(due.rows.map((row) => row.question_id)).toEqual(['q_new', 'q_due']);
    expect(due.queue_summary.never_reviewed_count).toBe(1);
    expect(due.queue_summary.overdue_count).toBe(1);

    await testDb()
      .insert(question)
      .values({
        id: 'q_due_zhi_only',
        kind: 'short_answer',
        prompt_md: '只考「之」',
        reference_md: '结构助词。',
        source: 'manual',
        knowledge_ids: ['k_zhi'],
        created_at: new Date(BASE.getTime() - 2_000),
        updated_at: BASE,
      });
    await testDb()
      .insert(material_fsrs_state)
      .values({
        id: 'fsrs_due_zhi_only',
        subject_kind: 'knowledge',
        subject_id: 'k_zhi',
        state: fsrsState(new Date(BASE.getTime() - 172_800_000)) as never,
        due_at: new Date(BASE.getTime() - 172_800_000),
        updated_at: BASE,
      });
    const filteredDue = await getReviewDueTool.execute(ctx(), {
      limit: 1,
      knowledgeIds: ['k_er'],
    });
    expect(filteredDue.rows.map((row) => row.question_id)).toEqual(['q_due']);

    const itemContext = await getLearningItemContextTool.execute(ctx(), {
      learningItemId: 'li_zhi',
      include: [
        'parent',
        'primary_artifact',
        'completion_evidence',
        'recent_events',
        'records',
        'knowledge_context',
      ],
    });
    expect(itemContext.item?.primary_artifact_id).toBe('art_note');
    expect(itemContext.hierarchy?.parent?.id).toBe('li_parent');
    expect(itemContext.primary_artifact?.section_summaries[0]).toContain('concept');
    expect(itemContext.evidence?.[0].id).toBe('ev_complete');

    const brief = await queryMemoryBriefTool.execute(ctx(), {
      scopeKey: 'global',
      includeEvidence: true,
    });
    expect(brief.note?.recent_week_md).toContain('虚词');
    expect(brief.evidence?.recent_week_ids).toEqual(['rec_mistake']);

    const rows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.id, 'att_new')));
    expect(rows).toHaveLength(1);
  });

  // codex PR #298 #3357932403 — a DRAFT question with a failure attempt (and no
  // FSRS row) must NOT enter the never-reviewed-failure slice. The FSRS-keyed
  // branches' draft filter can't see it (no material_fsrs_state row), so the
  // never-reviewed question SELECT must apply the draft exclusion itself.
  it('excludes a draft question with a failure attempt from never-reviewed', async () => {
    const db = testDb();
    await db.insert(question).values({
      id: 'q_draft_fail',
      kind: 'short_answer',
      prompt_md: '草稿题（未验证）',
      reference_md: '参考',
      source: 'manual',
      knowledge_ids: ['k_zhi'],
      draft_status: 'draft',
      created_at: BASE,
      updated_at: BASE,
    });
    await writeEvent(db, {
      id: 'att_draft_fail',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_draft_fail',
      outcome: 'failure',
      payload: {
        answer_md: '错答',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_zhi'],
      },
      created_at: new Date(BASE.getTime() + 10_000),
    });

    const due = await getReviewDueTool.execute(ctx(), { limit: 20 });
    const ids = due.rows.map((row) => row.question_id);
    expect(ids).not.toContain('q_draft_fail');
  });
});
