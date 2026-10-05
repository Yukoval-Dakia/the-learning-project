import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { ColdStartBridgeError, type ColdStartBridgeRunTaskFn } from './cold-start-bridge';
import { createKnowledgeNamer } from './knowledge-namer';

vi.mock('@/server/ai/runner-fn', () => ({
  makeRunTaskTextFn: () => {
    throw new Error('A naming contract test must not call a provider');
  },
}));
vi.mock('@/subjects/profile', () => ({
  getDefaultSubjectRegistry: () => ({
    get: (id: string) => (id === 'opaque-math' ? { displayName: '数学（高等代数）' } : undefined),
  }),
}));

// No DB operation belongs to this adapter; all model work occurs before enrollment's transaction.
const db = {} as Db;
const questionText = [
  '设 V 为三维实向量空间，T 的矩阵包含参数 a 与非对角项。',
  '第一问：讨论不同 a 下的特征空间；第二问：给出不能对角化时的反例。',
  '注意：特征值相同不代表具有足够的线性无关特征向量。'.repeat(20),
].join('\n');
const input = {
  questionText,
  knowledgeHint: '重复特征值 / 几何重数，不能直接套用对称矩阵结论',
  subjectId: 'opaque-math',
  knownSubjects: [{ id: 'opaque-physics', display_name: '物理' }],
};

describe('ingestion-owned knowledge naming', () => {
  it('uses one pinned-subject call, preserves the question and caller cancellation context', async () => {
    const controller = new AbortController();
    const ctx = {
      db,
      signal: controller.signal,
      parentTaskRunId: 'run-parent',
      nested: { source: 'upload' },
    };
    const runTaskFn = vi.fn<ColdStartBridgeRunTaskFn>(async () => ({
      text: JSON.stringify({
        subject_id: input.subjectId,
        kc_name: '重特征值与可对角化条件',
        reference_md: '(reference answer not needed for tagging)',
        reasoning: '命名，不重新生成参考答案',
      }),
    }));
    const result = await createKnowledgeNamer({ db, ctx, runTaskFn })(input);
    expect(result).toEqual({ kc_name: '重特征值与可对角化条件' });
    expect(runTaskFn).toHaveBeenCalledExactlyOnceWith(
      'ColdStartPlacementBridgeTask',
      {
        question_md: questionText,
        knowledge_hint: input.knowledgeHint,
        existing_reference_md: '(reference answer not needed for tagging)',
        known_subjects: [{ id: input.subjectId, display_name: '数学（高等代数）' }],
      },
      ctx,
    );
    expect(runTaskFn.mock.calls[0]?.[2]).toBe(ctx);
  });

  it('keeps a custom subject pinned even when the registry and caller vocabulary omit it', async () => {
    const runTaskFn = vi.fn<ColdStartBridgeRunTaskFn>(async (_kind, request, ctx) => {
      expect(request.known_subjects).toEqual([{ id: 'custom-id', display_name: 'custom-id' }]);
      expect(ctx).toEqual({ db });
      return {
        text: JSON.stringify({
          subject_id: 'custom-id',
          kc_name: '自定义科目知识点',
          reference_md: '',
        }),
      };
    });
    await expect(
      createKnowledgeNamer({ db, runTaskFn })({ ...input, subjectId: 'custom-id' }),
    ).resolves.toEqual({ kc_name: '自定义科目知识点' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    JSON.stringify({ subject_id: 'opaque-physics', kc_name: '错误科目', reference_md: '' }),
    '无法返回结构化的知识点命名',
  ])('rejects invalid naming output without retrying or creating another task', async (text) => {
    const runTaskFn = vi.fn<ColdStartBridgeRunTaskFn>(async () => ({ text }));
    await expect(createKnowledgeNamer({ db, runTaskFn })(input)).rejects.toBeInstanceOf(
      ColdStartBridgeError,
    );
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });
});
