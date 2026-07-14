import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  actorMeta,
  correctionMeta,
  eventTone,
  outcomeLabel,
  subjectHref,
  subjectLabel,
} from './event-detail-model';

describe('event detail learner labels', () => {
  it('maps known event fields to learner-facing language', () => {
    expect(actionLabel('attempt')).toBe('作答');
    expect(outcomeLabel('failure')).toBe('失败');
    expect(subjectLabel('question')).toBe('题目');
    expect(actorMeta('agent').label).toBe('AI');
    expect(correctionMeta('marked_wrong')).toMatchObject({ label: '已标记为错误' });
  });

  it('does not leak unknown enum values through fallbacks', () => {
    expect(actionLabel('experimental:new_internal_action')).toBe('AI 分析');
    expect(actionLabel('opaque_internal_action')).toBe('学习记录');
    expect(outcomeLabel('opaque_outcome')).toBe('已记录');
    expect(subjectLabel('opaque_subject')).toBe('学习对象');
    expect(actorMeta('opaque_actor').label).toBe('系统');
  });

  it('routes only subject kinds with real detail surfaces', () => {
    expect(subjectHref({ subject_kind: 'question', subject_id: 'q/a' })).toBe('/questions/q%2Fa');
    expect(subjectHref({ subject_kind: 'knowledge', subject_id: 'k:1' })).toBe('/knowledge/k%3A1');
    expect(subjectHref({ subject_kind: 'artifact', subject_id: 'note_1' })).toBe('/notes/note_1');
    expect(subjectHref({ subject_kind: 'event', subject_id: 'evt_1' })).toBe('/events/evt_1');
    expect(subjectHref({ subject_kind: 'learning_session', subject_id: 's1' })).toBeNull();
  });

  it('derives honest visual tone from outcome before action', () => {
    expect(eventTone({ action: 'experimental:anything', outcome: 'failure' })).toBe('again');
    expect(eventTone({ action: 'propose', outcome: null })).toBe('coral');
    expect(eventTone({ action: 'attempt', outcome: 'success' })).toBe('good');
  });
});
