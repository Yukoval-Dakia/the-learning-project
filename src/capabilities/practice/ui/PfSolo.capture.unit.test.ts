// YUK-562 (过程框) + YUK-444 (信心自评) — PfSolo 采集 UI 的纯逻辑单测。
//
// PfSolo 没有 render 测试 harness（项目不带 jsdom/testing-library，引入属 scope creep，见
// PfSolo.detection.unit.test.ts 同款说明）。故两处采集控件的**判定 + 装配 + 相位时序**都被抽成
// 纯函数（shouldOfferProcessBox / shouldOfferConfidenceGate / buildCaptureFields / derivePhase），
// 它们就是 JSX 里 gate / wire-body / 相位切换的唯一开关，在此固定不变式。
//
// No-DB unit partition（不 import db/postgres/drizzle）。

import { describe, expect, it } from 'vitest';
// 常量走 @/kernel/limits（与生产 PfSolo 同一条路径，PR #1069 边界修复）。ReviewOnQuestion 仍直取
// core event schema：本测试的意图正是拿**事件 payload schema 本体**校验 UI 装配出的 wire body，
// 跨层断言是它的目的；生产 UI 代码不得如此。
import { ReviewOnQuestion } from '@/core/schema/event/known';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import {
  buildCaptureFields,
  derivePhase,
  shouldOfferConfidenceGate,
  shouldOfferProcessBox,
} from './PfSolo';
import type { JudgePreview } from './practice-api';

const judge = (route: string): JudgePreview => ({
  route,
  score: 0.9,
  score_meaning: 'correctness',
  coarse_outcome: 'correct',
  confidence: 0.9,
  feedback_md: 'ok',
  evidence_json: {},
  capability_ref: { id: route, version: '1' },
  suggested_rating: 'good',
  task_run_id: 'run-1',
  provenance_token: 'tok',
});

describe('shouldOfferProcessBox — 过程框只对开放/文本作答题显示 (YUK-562)', () => {
  it('开放/文本作答题（!isChoice）→ 显示过程框', () => {
    expect(shouldOfferProcessBox(false)).toBe(true);
  });

  it('客观（选择）题（isChoice）→ 隐藏过程框（不渲染两控件之一）', () => {
    // 选择题渲染 radio、无作答 composer，过程框无处可挂；作答面形态是提交前唯一可用信号。
    expect(shouldOfferProcessBox(true)).toBe(false);
  });
});

describe('shouldOfferConfidenceGate — 信心自评插拍只在非客观判分流 (YUK-444)', () => {
  it('客观题（route exact/keyword）→ 不插拍（auto-commit 流跳过，不渲染两控件之一）', () => {
    expect(shouldOfferConfidenceGate('exact')).toBe(false);
    expect(shouldOfferConfidenceGate('keyword')).toBe(false);
  });

  it('开放题（route semantic/rubric/steps）→ 插信心自评拍', () => {
    expect(shouldOfferConfidenceGate('semantic')).toBe(true);
    expect(shouldOfferConfidenceGate('rubric')).toBe(true);
    expect(shouldOfferConfidenceGate('steps')).toBe(true);
  });

  it('与 isObjectiveQuestion 严格互补：gate ⟺ 非客观 route', () => {
    for (const route of ['exact', 'keyword']) expect(shouldOfferConfidenceGate(route)).toBe(false);
    for (const route of ['semantic', 'rubric', 'steps', 'advice', 'reading'])
      expect(shouldOfferConfidenceGate(route)).toBe(true);
  });
});

describe('buildCaptureFields — 零强制「空值不发字段」装配 (YUK-562 / YUK-444)', () => {
  it('两者皆空 → 空对象（wire body 无 reasoning_trace / self_confidence 键 → event byte-identical）', () => {
    expect(buildCaptureFields({ reasoningTrace: '', selfConfidence: null })).toEqual({});
  });

  it('纯空白过程文本 → 不发 reasoning_trace（trim 判空，挡空白噪声）', () => {
    expect(buildCaptureFields({ reasoningTrace: '   \n\t ', selfConfidence: null })).toEqual({});
  });

  it('非空过程文本 → 带 reasoning_trace（原文，含首尾非空白内容）', () => {
    expect(buildCaptureFields({ reasoningTrace: '先设未知数 x', selfConfidence: null })).toEqual({
      reasoning_trace: '先设未知数 x',
    });
  });

  it('跳过信心自评（null）→ 不发 self_confidence', () => {
    expect(buildCaptureFields({ reasoningTrace: '', selfConfidence: null })).toEqual({});
    expect(
      Object.hasOwn(
        buildCaptureFields({ reasoningTrace: 'x', selfConfidence: null }),
        'self_confidence',
      ),
    ).toBe(false);
  });

  it('选了信心档（1-5）→ 带 self_confidence（含边界 1 与 5）', () => {
    expect(buildCaptureFields({ reasoningTrace: '', selfConfidence: 1 })).toEqual({
      self_confidence: 1,
    });
    expect(buildCaptureFields({ reasoningTrace: '', selfConfidence: 5 })).toEqual({
      self_confidence: 5,
    });
  });

  it('两者都有 → 同时带两个字段', () => {
    expect(buildCaptureFields({ reasoningTrace: '思路：分类讨论', selfConfidence: 3 })).toEqual({
      reasoning_trace: '思路：分类讨论',
      self_confidence: 3,
    });
  });

  it('超界过程文本 → 发送前防御性截断到 REASONING_TRACE_MAX_LEN（挡 400 软死锁）', () => {
    // PR #1065 thread：原样发超界文本 → server zod .max() 抛 400，且此刻 UI 已离作答相位无法回改。
    const over = 'x'.repeat(REASONING_TRACE_MAX_LEN + 500);
    const fields = buildCaptureFields({ reasoningTrace: over, selfConfidence: null });
    expect(fields.reasoning_trace).toHaveLength(REASONING_TRACE_MAX_LEN);
  });

  it('截断后的过程文本恒过 server 端 ReviewOnQuestion zod .max() 校验', () => {
    // 截断值直接喂进 review payload 校验，坐实「不再撞 400」——slice 与 zod 同按 UTF-16 code unit 计长。
    const fields = buildCaptureFields({
      reasoningTrace: 'y'.repeat(REASONING_TRACE_MAX_LEN + 1),
      selfConfidence: 2,
    });
    const parsed = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: {
          due: '2026-01-01T00:00:00.000Z',
          stability: 1,
          difficulty: 5,
          elapsed_days: 0,
          scheduled_days: 1,
          learning_steps: 0,
          reps: 1,
          lapses: 0,
          state: 'review',
          last_review: '2026-01-01T00:00:00.000Z',
        },
        user_response_md: 'a',
        referenced_knowledge_ids: ['kc1'],
        reasoning_trace: fields.reasoning_trace,
        self_confidence: fields.self_confidence,
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('derivePhase — 推迟揭晓「先自评、后揭晓」相位时序 (YUK-444)', () => {
  it('无 preview / 无 pending → answering（作答，判定未跑）', () => {
    expect(derivePhase(null, null)).toBe('answering');
  });

  it('judge 结果暂存 pending、preview 仍 null → confidence（插信心自评拍，判定卡不渲染）', () => {
    // 关键不变式：judge 已返回但揭晓被推迟 —— 只要 preview 还是 null，就停在自评拍。
    expect(derivePhase(null, judge('semantic'))).toBe('confidence');
  });

  it('preview 已揭晓（revealVerdict 提上）→ feedback（判定卡）', () => {
    expect(derivePhase(judge('semantic'), null)).toBe('feedback');
  });

  it('preview 优先：揭晓后（preview 有值）恒 feedback，不回退自评拍', () => {
    // revealVerdict 清 pending 的同时 setPreview；即便 race 下两者短暂并存，preview 也压过。
    expect(derivePhase(judge('semantic'), judge('semantic'))).toBe('feedback');
  });
});
