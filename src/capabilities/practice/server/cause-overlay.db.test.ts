// YUK-1016 / 454-B — cause_category_overlay DB 测试。
// 覆盖：reader 过滤语义（active-only / subject-scope / 序）、proposal→accept→row、
// idempotent accept、retract→archived、attribution 合并读取（ov_ 进候选 + 校验
// 不 clamp）、variant targetable、other tally→propose 全链。

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cause_category_overlay, event, knowledge, question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { acceptAiProposal, retractAiProposal } from '@/server/proposals/actions';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { AttributionInput } from '../tasks/attribution';
import {
  getCauseCategoryOverlaysByIds,
  listActiveCauseCategoryOverlays,
  overlayToCandidate,
} from './cause-overlay';
import { runAttributionAndWriteJudgeEvent } from './failure-learning-attribution';
import { runVariantGen } from './failure-learning-variant';

const NOW = new Date('2026-09-18T00:00:00Z');

async function seedOverlay(opts: {
  id: string;
  subjectId?: string;
  label?: string;
  status?: 'draft' | 'active';
  archived?: boolean;
}) {
  const db = testDb();
  await db.insert(cause_category_overlay).values({
    id: opts.id,
    subject_id: opts.subjectId ?? 'general',
    label: opts.label ?? opts.id,
    description: 'overlay 测试类目',
    source: 'llm_propose',
    status: opts.status ?? 'active',
    evidence_event_ids: [],
    created_at: NOW,
    updated_at: NOW,
    archived_at: opts.archived ? NOW : null,
  });
}

async function seedQuestion(questionId: string, knowledgeIds: string[] = []) {
  const db = testDb();
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'test prompt',
    reference_md: 'ref',
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'test',
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function seedAttempt(
  attemptId: string,
  questionId: string,
  at: Date = NOW,
  referencedKnowledgeIds: string[] = [],
) {
  const db = testDb();
  await db.insert(event).values({
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: referencedKnowledgeIds,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: at,
  });
}

async function seedJudge(
  judgeId: string,
  attemptId: string,
  primaryCategory: string,
  at: Date = NOW,
  attributionPending = false,
) {
  const db = testDb();
  await db.insert(event).values({
    id: judgeId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: primaryCategory,
        secondary_categories: [],
        analysis_md: `${primaryCategory} 分析`,
        confidence: 0.8,
        meta_cause: null,
        meta_cause_secondary: null,
        metacog_flag: null,
        bloom_level: null,
        self_corrected_on_hint: null,
        recurred_cross_item: null,
      },
      referenced_knowledge_ids: [],
      profile_version: 'test',
      ...(attributionPending ? { attribution_pending: true } : {}),
    },
    caused_by_event_id: attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: at,
  });
}

async function seedKnowledge(id: string, domain: string | null) {
  const db = testDb();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function writeCauseCategoryProposal(opts: {
  categoryId: string;
  label?: string;
  source?: 'owner' | 'llm_propose';
  subjectId?: string;
  cooldownKey?: string;
}) {
  const db = testDb();
  return writeAiProposal(db, {
    payload: {
      kind: 'cause_category',
      target: {
        subject_kind: 'subject_profile',
        subject_id: opts.subjectId ?? 'general',
      },
      reason_md: '测试提议',
      evidence_refs: [{ kind: 'event', id: 'evt_seed_1' }],
      cooldown_key: opts.cooldownKey ?? `cause_category:${opts.subjectId ?? 'general'}`,
      proposed_change: {
        category_id: opts.categoryId,
        label: opts.label ?? '测试类目',
        description: '说明文字',
        source: opts.source ?? 'llm_propose',
      },
    },
  });
}

const validInput: AttributionInput = {
  prompt_md: '"之"在主谓之间的用法?',
  reference_md: '取消句子独立性',
  wrong_answer_md: '助词',
  knowledge_context: [],
};

describe('listActiveCauseCategoryOverlays / getCauseCategoryOverlaysByIds', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns only active+unarchived rows for the subject, ordered by created_at', async () => {
    await seedOverlay({ id: 'ov_alpha', status: 'active' });
    await seedOverlay({ id: 'ov_draft', status: 'draft' });
    await seedOverlay({ id: 'ov_gone', status: 'active', archived: true });
    await seedOverlay({ id: 'ov_other_subject', subjectId: 'math', status: 'active' });

    const rows = await listActiveCauseCategoryOverlays(testDb(), 'general');
    expect(rows.map((row) => row.id)).toEqual(['ov_alpha']);

    const mathRows = await listActiveCauseCategoryOverlays(testDb(), 'math');
    expect(mathRows.map((row) => row.id)).toEqual(['ov_other_subject']);
  });

  it('getCauseCategoryOverlaysByIds returns rows regardless of status', async () => {
    await seedOverlay({ id: 'ov_live', status: 'active' });
    await seedOverlay({ id: 'ov_dead', status: 'active', archived: true });
    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_live', 'ov_dead', 'ov_none']);
    expect(rows.map((row) => row.id).sort()).toEqual(['ov_dead', 'ov_live']);
    expect(await getCauseCategoryOverlaysByIds(testDb(), [])).toEqual([]);
  });

  it('overlayToCandidate maps the minimal declaration shape', async () => {
    await seedOverlay({ id: 'ov_x', label: '语义类目' });
    const [row] = await listActiveCauseCategoryOverlays(testDb(), 'general');
    expect(overlayToCandidate(row)).toEqual({
      id: 'ov_x',
      label: '语义类目',
      description: 'overlay 测试类目',
    });
  });
});

describe('cause_category proposal → accept → overlay row', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('accept inserts an active overlay row carrying evidence + source', async () => {
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'ov_time_pressure' });
    const result = await acceptAiProposal(testDb(), proposalId);
    expect(result.kind).toBe('cause_category');

    const [row] = await getCauseCategoryOverlaysByIds(testDb(), ['ov_time_pressure']);
    expect(row).toBeTruthy();
    expect(row.subject_id).toBe('general');
    expect(row.label).toBe('测试类目');
    expect(row.description).toBe('说明文字');
    expect(row.source).toBe('llm_propose');
    expect(row.status).toBe('active');
    expect(row.archived_at).toBeNull();
    expect(row.evidence_event_ids).toEqual(['evt_seed_1']);
    // 归属列：行记录落地它的 proposal event id（retract 按此限定）。
    expect(row.proposal_event_id).toBe(proposalId);

    // 返回的 rate_event_id 必须是真落库的 rate event（review P1-1 幻影 id）。
    const rateRows = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.id, result.rate_event_id as string), eq(event.action, 'rate')));
    expect(rateRows).toHaveLength(1);
  });

  it('re-accept is idempotent (one row, one rate event)', async () => {
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'ov_idem' });
    await acceptAiProposal(testDb(), proposalId);
    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second.idempotent).toBe(true);

    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_idem']);
    expect(rows).toHaveLength(1);
  });

  it('retract archives the accepted row (reader excludes it afterwards)', async () => {
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'ov_retract' });
    await acceptAiProposal(testDb(), proposalId);
    await retractAiProposal(testDb(), proposalId, { reason_md: '收回' });

    const [row] = await getCauseCategoryOverlaysByIds(testDb(), ['ov_retract']);
    expect(row.archived_at).not.toBeNull();
    expect(await listActiveCauseCategoryOverlays(testDb(), 'general')).toEqual([]);
  });

  it('retract of a DIFFERENT pending proposal does NOT archive the owned row', async () => {
    // 同 slug 两张 pending proposal 并存：A accept 落行、B 仍 pending——retract B
    // 不许把 A 的行归档（proposal_event_id 归属限定，review P1-2）。
    const proposalA = await writeCauseCategoryProposal({
      categoryId: 'ov_shared',
      subjectId: 'general',
    });
    const proposalB = await writeCauseCategoryProposal({
      categoryId: 'ov_shared',
      subjectId: 'math',
      cooldownKey: 'cause_category:math',
    });
    await acceptAiProposal(testDb(), proposalA);
    await retractAiProposal(testDb(), proposalB, { reason_md: '不要了' });

    const [row] = await getCauseCategoryOverlaysByIds(testDb(), ['ov_shared']);
    expect(row.archived_at).toBeNull();
    expect(row.proposal_event_id).toBe(proposalA);
    expect(row.status).toBe('active');
  });

  it('accept rejects a category_id outside the ov_ namespace', async () => {
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'concept' });
    await expect(acceptAiProposal(testDb(), proposalId)).rejects.toThrow(/ov_/);
    expect(await getCauseCategoryOverlaysByIds(testDb(), ['concept'])).toEqual([]);
  });

  it('accept rejects the bare ov_ prefix (empty slug) with 400', async () => {
    // 裸前缀（slug 为空）比「不在命名空间」更隐蔽——显式 400 而非依赖后续路径。
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'ov_' });
    await expect(acceptAiProposal(testDb(), proposalId)).rejects.toThrow(/empty slug/);
    expect(await getCauseCategoryOverlaysByIds(testDb(), ['ov_'])).toEqual([]);
  });

  it('concurrent accepts of the same category_id: exactly one wins, loser gets 409', async () => {
    // 两张 pending proposal 指同一 categoryId、并发 accept——decision lock 按
    // proposalId 取不互斥，onConflictDoNothing 兜底保证输家是 409 而非裸 PK 500。
    const proposalA = await writeCauseCategoryProposal({
      categoryId: 'ov_race',
      subjectId: 'general',
    });
    const proposalB = await writeCauseCategoryProposal({
      categoryId: 'ov_race',
      subjectId: 'math',
      cooldownKey: 'cause_category:math',
    });
    const [a, b] = await Promise.allSettled([
      acceptAiProposal(testDb(), proposalA),
      acceptAiProposal(testDb(), proposalB),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((r) => r.status === 'rejected');
    expect(loser?.status).toBe('rejected');
    if (loser?.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(ApiError);
      expect((loser.reason as ApiError).status).toBe(409);
    }

    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_race']);
    expect(rows).toHaveLength(1);
  });
});

describe('attribution 合并读取（overlay ∪ 声明词表）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('active overlay 类目进入 rerank 候选（声明词表之后）且 ov_ primary 不被 clamp', async () => {
    const db = testDb();
    await seedOverlay({ id: 'ov_careless_rush', label: '抢速度' });
    await seedQuestion('q_ov1');
    await seedAttempt('att_ov1', 'q_ov1');

    const spy = vi.fn(async (_kind: string, _input: unknown) => ({
      text: '{"primary_category":"ov_careless_rush","secondary_categories":[],"analysis_md":"抢速度未验算","confidence":0.75}',
    }));
    const res = await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_ov1',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    expect(res.outcome).toBe('written');

    const rerankInput = spy.mock.calls[0][1] as { candidates: Array<{ id: string }> };
    const ids = rerankInput.candidates.map((c) => c.id);
    const general = resolveSubjectProfile('general');
    // overlay 追加在声明词表之后（声明序保持，ov_ 殿后）。
    expect(ids.slice(0, general.causeCategories.length)).toEqual(
      general.causeCategories.map((c) => c.id),
    );
    expect(ids).toContain('ov_careless_rush');

    const judgeRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, 'att_ov1')));
    const cause = (judgeRows[0].payload as { cause: { primary_category: string } }).cause;
    // ov_ primary 落到 judge —— 不被 clamp 成 other。
    expect(cause.primary_category).toBe('ov_careless_rush');
  });

  it('draft/archived overlay 行不进候选（候选 == 声明词表原样）', async () => {
    const db = testDb();
    await seedOverlay({ id: 'ov_hidden', status: 'draft' });
    await seedOverlay({ id: 'ov_dead2', status: 'active', archived: true });
    await seedQuestion('q_ov2');
    await seedAttempt('att_ov2', 'q_ov2');

    const spy = vi.fn(async (_kind: string, _input: unknown) => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"x","confidence":0.8}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_ov2',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    const rerankInput = spy.mock.calls[0][1] as { candidates: Array<{ id: string }> };
    expect(rerankInput.candidates.map((c) => c.id)).not.toContain('ov_hidden');
    expect(rerankInput.candidates.map((c) => c.id)).not.toContain('ov_dead2');
    expect(rerankInput.candidates).toEqual(resolveSubjectProfile('general').causeCategories);
  });
});

describe('variant targetable：ov_ primary', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('active overlay primary → targetable，label 进 prompt input', async () => {
    const db = testDb();
    await seedOverlay({ id: 'ov_rush', label: '抢速度' });
    await seedQuestion('q_ov3');
    await seedAttempt('att_ov3', 'q_ov3');
    await seedJudge('j_ov3', 'att_ov3', 'ov_rush');

    const spy = vi.fn(async (_kind: string, _input: unknown) => ({
      text: '{"prompt_md":"变式题","reference_md":"ref","difficulty":3,"reasoning":"r"}',
    }));
    const res = await runVariantGen({
      db,
      attemptEventId: 'att_ov3',
      runTaskFn: spy,
    });
    expect(res.status).toBe('proposed');

    const input = spy.mock.calls[0][1] as { cause: { primary_category: string } };
    // prompt 侧拿到 label（语义），不是 opaque id。
    expect(input.cause.primary_category).toBe('抢速度');
  });

  it('archived overlay primary → skipped:cause_not_targetable', async () => {
    const db = testDb();
    await seedOverlay({ id: 'ov_dead3', status: 'active', archived: true });
    await seedQuestion('q_ov4');
    await seedAttempt('att_ov4', 'q_ov4');
    await seedJudge('j_ov4', 'att_ov4', 'ov_dead3');

    const spy = vi.fn(async () => ({ text: '{}' }));
    const res = await runVariantGen({
      db,
      attemptEventId: 'att_ov4',
      runTaskFn: spy,
    });
    expect(res.status).toBe('skipped:cause_not_targetable');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('other 复发 tally → LLM 提议 → proposal event', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedOtherCluster(count: number, kcId = 'k_other_cluster') {
    // attempt 必须带「可解析」KC 才进科目桶（YUK-1019：零信号/悬空 KC 一律
    // unresolved 不计数）。domain=null → resolveSubjectProfile → general。
    await seedKnowledge(kcId, null);
    for (let i = 0; i < count; i += 1) {
      await seedQuestion(`q_other_${i}`);
      await seedAttempt(`att_other_${i}`, `q_other_${i}`, new Date(NOW.getTime() + i * 1000), [
        kcId,
      ]);
      await seedJudge(
        `j_other_${i}`,
        `att_other_${i}`,
        'other',
        new Date(NOW.getTime() + i * 1000 + 500),
      );
    }
  }

  it('≥3 个 other → 归因再落 other 时调 CauseCategoryProposeTask 并写 proposal', async () => {
    const db = testDb();
    await seedOtherCluster(3);
    await seedQuestion('q_trigger');
    await seedAttempt('att_trigger', 'q_trigger', new Date(NOW.getTime() + 10_000));

    const spy = vi.fn(async (kind: string) => {
      if (kind === 'CauseCategoryProposeTask') {
        return {
          text: '{"action":"propose","slug":"time_pressure","label":"时间压力","description":"限时压缩步骤","rationale_md":"三个样本共享限时跳步模式"}',
          task_run_id: 'tr_prop',
          cost_usd: 0.001,
        };
      }
      return {
        text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"又是限时跳步","confidence":0.4}',
      };
    });
    const res = await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    expect(res.outcome).toBe('written');
    expect(spy).toHaveBeenCalledWith(
      'CauseCategoryProposeTask',
      expect.objectContaining({ recurrence_count: expect.any(Number) }),
      expect.anything(),
    );

    const proposals = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:proposal'), eq(event.subject_kind, 'subject_profile')),
      );
    expect(proposals).toHaveLength(1);
    const payload = proposals[0].payload as {
      ai_proposal: {
        kind: string;
        cooldown_key: string;
        proposed_change: { category_id: string; source: string; label: string };
      };
    };
    expect(payload.ai_proposal.kind).toBe('cause_category');
    expect(payload.ai_proposal.proposed_change.category_id).toBe('ov_time_pressure');
    expect(payload.ai_proposal.proposed_change.source).toBe('llm_propose');
    expect(payload.ai_proposal.proposed_change.label).toBe('时间压力');
  });

  it('已有 pending cause_category proposal → 不再调 LLM（per-subject 去重）', async () => {
    const db = testDb();
    await seedOtherCluster(3);
    await writeCauseCategoryProposal({ categoryId: 'ov_existing_pending' });
    await seedQuestion('q_trigger2');
    await seedAttempt('att_trigger2', 'q_trigger2', new Date(NOW.getTime() + 10_000));

    const spy = vi.fn(async () => ({
      text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
    }));
    const res = await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger2',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    expect(res.outcome).toBe('written');
    expect(spy).toHaveBeenCalledTimes(1); // 只有 AttributionRerankTask
  });

  it('other 不足 floor → 只写 judge，不调 CauseCategoryProposeTask', async () => {
    const db = testDb();
    await seedOtherCluster(1);
    await seedQuestion('q_trigger3');
    await seedAttempt('att_trigger3', 'q_trigger3', new Date(NOW.getTime() + 10_000));

    const spy = vi.fn(async () => ({
      text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger3',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const proposals = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(0);
  });

  it('attribution_pending 占位 judge 不计入 floor（review P1b）', async () => {
    const db = testDb();
    // 3 个占位 'other'（paper/review 提交的「归因待跑」标记）——不得凑满 floor。
    for (let i = 0; i < 3; i += 1) {
      await seedQuestion(`q_ph_${i}`);
      await seedAttempt(`att_ph_${i}`, `q_ph_${i}`, new Date(NOW.getTime() + i * 1000));
      await seedJudge(
        `j_ph_${i}`,
        `att_ph_${i}`,
        'other',
        new Date(NOW.getTime() + i * 1000 + 500),
        true, // attribution_pending
      );
    }
    await seedQuestion('q_trigger4');
    await seedAttempt('att_trigger4', 'q_trigger4', new Date(NOW.getTime() + 10_000));

    const spy = vi.fn(async () => ({
      text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger4',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    // 占位 3 + 刚写的真 'other' 1 = floor(3) 未满——只有 rerank 一次调用。
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('跨科目 other 不计入本科目 floor（review P1a subject 收敛）', async () => {
    const db = testDb();
    await seedKnowledge('k_math', 'math');
    // 3 个 math 域的 other——对 general 的 tally 不可见。
    for (let i = 0; i < 3; i += 1) {
      await seedQuestion(`q_m_${i}`, ['k_math']);
      await seedAttempt(`att_m_${i}`, `q_m_${i}`, new Date(NOW.getTime() + i * 1000), ['k_math']);
      await seedJudge(`j_m_${i}`, `att_m_${i}`, 'other', new Date(NOW.getTime() + i * 1000 + 500));
    }
    await seedQuestion('q_trigger5');
    await seedAttempt('att_trigger5', 'q_trigger5', new Date(NOW.getTime() + 10_000));

    const spy = vi.fn(async () => ({
      text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger5',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    // general 侧只有触发 judge 的 1 个 other < floor——LLM 不被调。
    expect(spy).toHaveBeenCalledTimes(1);

    // 换 math profile 重放同一 attempt 形态：3 个 math other + 触发 = 4 ≥ floor。
    const spyMath = vi.fn(async (kind: string) => {
      if (kind === 'CauseCategoryProposeTask') {
        return {
          text: '{"action":"propose","slug":"math_rush","label":"计算跳步","rationale_md":"r"}',
          task_run_id: 'tr_m',
          cost_usd: 0.001,
        };
      }
      return {
        text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
      };
    });
    await seedQuestion('q_trigger_m');
    await seedAttempt('att_trigger_m', 'q_trigger_m', new Date(NOW.getTime() + 20_000), ['k_math']);
    const resMath = await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger_m',
      input: validInput,
      runTaskFn: spyMath,
      subjectProfile: resolveSubjectProfile('math'),
    });
    expect(resMath.outcome).toBe('written');
    expect(spyMath).toHaveBeenCalledWith(
      'CauseCategoryProposeTask',
      expect.objectContaining({ subject_display_name: resolveSubjectProfile('math').displayName }),
      expect.anything(),
    );
  });

  it('悬空 [0] + 可解析 [1]：首个可解析 KC 定桶（YUK-1019 review P1a）', async () => {
    const db = testDb();
    await seedKnowledge('k_math2', 'math');
    // 3 个 other：referenced[0]='k_ghost'（无 knowledge 行，悬空）+ [1]='k_math2'
    // （可解析 math）。修复前 [0] 悬空 → domain null → general 桶；修复后首个
    // 可解析 KC 决定归属 → math 桶，不再虚增 general。
    for (let i = 0; i < 3; i += 1) {
      await seedQuestion(`q_dg_${i}`);
      await seedAttempt(`att_dg_${i}`, `q_dg_${i}`, new Date(NOW.getTime() + i * 1000), [
        'k_ghost',
        'k_math2',
      ]);
      await seedJudge(
        `j_dg_${i}`,
        `att_dg_${i}`,
        'other',
        new Date(NOW.getTime() + i * 1000 + 500),
      );
    }
    await seedQuestion('q_trigger_dg');
    await seedAttempt('att_trigger_dg', 'q_trigger_dg', new Date(NOW.getTime() + 10_000), [
      'k_math2',
    ]);

    const spy = vi.fn(async (kind: string) => {
      if (kind === 'CauseCategoryProposeTask') {
        return {
          text: '{"action":"propose","slug":"math_gap","label":"数学断点","rationale_md":"r"}',
          task_run_id: 'tr_dg',
          cost_usd: 0.001,
        };
      }
      return {
        text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
      };
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger_dg',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('math'),
    });
    // math 侧 3 个可解析 other + 触发 = 4 ≥ floor → LLM 被调。
    expect(spy).toHaveBeenCalledWith(
      'CauseCategoryProposeTask',
      expect.objectContaining({ subject_display_name: resolveSubjectProfile('math').displayName }),
      expect.anything(),
    );
  });

  it('全不可解析 KC 的 other 不进任何科目桶（YUK-1019 review P1b unresolved）', async () => {
    const db = testDb();
    // 3 个 other，referenced KC 全部悬空（无 knowledge 行）——不得凑 general floor。
    for (let i = 0; i < 3; i += 1) {
      await seedQuestion(`q_un_${i}`);
      await seedAttempt(`att_un_${i}`, `q_un_${i}`, new Date(NOW.getTime() + i * 1000), [
        `k_ghost_${i}`,
      ]);
      await seedJudge(
        `j_un_${i}`,
        `att_un_${i}`,
        'other',
        new Date(NOW.getTime() + i * 1000 + 500),
      );
    }
    await seedQuestion('q_trigger_un');
    await seedAttempt('att_trigger_un', 'q_trigger_un', new Date(NOW.getTime() + 10_000));

    const spy = vi.fn(async () => ({
      text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger_un',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    // 触发 attempt 无 KC → 也不可解析；unresolved 全部不计入 → floor 不达。
    expect(spy).toHaveBeenCalledTimes(1);
    const proposals = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(0);
  });

  it('proposal reason_md 标注 unresolved 计数（bucket=unresolved 可见）', async () => {
    const db = testDb();
    await seedKnowledge('k_gen', null); // 存在但 domain=null → resolveSubjectProfile→general
    // 3 个可解析 general other + 2 个全悬空 other。
    for (let i = 0; i < 3; i += 1) {
      await seedQuestion(`q_g_${i}`);
      await seedAttempt(`att_g_${i}`, `q_g_${i}`, new Date(NOW.getTime() + i * 1000), ['k_gen']);
      await seedJudge(`j_g_${i}`, `att_g_${i}`, 'other', new Date(NOW.getTime() + i * 1000 + 500));
    }
    for (let i = 0; i < 2; i += 1) {
      await seedQuestion(`q_ux_${i}`);
      await seedAttempt(`att_ux_${i}`, `q_ux_${i}`, new Date(NOW.getTime() + 5_000 + i * 1000), [
        `k_void_${i}`,
      ]);
      await seedJudge(
        `j_ux_${i}`,
        `att_ux_${i}`,
        'other',
        new Date(NOW.getTime() + 5_000 + i * 1000 + 500),
      );
    }
    await seedQuestion('q_trigger_an');
    await seedAttempt('att_trigger_an', 'q_trigger_an', new Date(NOW.getTime() + 10_000), [
      'k_gen',
    ]);

    const spy = vi.fn(async (kind: string) => {
      if (kind === 'CauseCategoryProposeTask') {
        return {
          text: '{"action":"propose","slug":"gen_gap","label":"通用断点","rationale_md":"r"}',
          task_run_id: 'tr_an',
          cost_usd: 0.001,
        };
      }
      return {
        text: '{"primary_category":"other","secondary_categories":[],"analysis_md":"x","confidence":0.4}',
      };
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'att_trigger_an',
      input: validInput,
      runTaskFn: spy,
      subjectProfile: resolveSubjectProfile('general'),
    });
    expect(spy).toHaveBeenCalledWith(
      'CauseCategoryProposeTask',
      expect.anything(),
      expect.anything(),
    );

    const proposals = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(1);
    const payload = proposals[0].payload as {
      ai_proposal: {
        reason_md: string;
        evidence_refs: Array<{ kind: string; id: string; event_role?: string }>;
      };
    };
    // 2 条悬空 + 不计入——owner 能在 reason 里看到被剔除的尾巴。
    expect(payload.ai_proposal.reason_md).toContain('bucket=unresolved');
    expect(payload.ai_proposal.reason_md).toContain('2');
    // evidence_refs 标 event_role：agent judge → 'judge'。
    expect(payload.ai_proposal.evidence_refs[0]?.event_role).toBe('judge');
  });
});
