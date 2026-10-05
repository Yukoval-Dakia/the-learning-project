import { describe, expect, it } from 'vitest';

import { FrozenQuestionSnapshotMigration } from '@/core/migration/validation';

import { FrozenQuestionSnapshotSchema, freezeQuestionForJudge } from './judge-run-payload';

// YUK-1048（终轮 P1-1）—— 迁移侧冻结输入镜像与生产契约的 parity 钉死。
// core 不得 import capability，故 FrozenQuestionSnapshotMigration 是
// judge-run-payload.ts FrozenQuestionSnapshotSchema 的逐字段镜像；本测试
// （住在 capability 侧、可 import 生产 schema）用同一语料断言双方 safeParse
// 同判 —— 任何一侧漂移（加字段/改类型/收紧约束）立即红。
//
// db 分区：judge-run-payload import 了 @/db/schema（drizzle 表定义），按
// 分区约定落 db config。

const VALID_SNAPSHOT = freezeQuestionForJudge({
  id: 'q-1',
  kind: 'short_answer',
  prompt_md: '1+1=?',
  reference_md: '2',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['kc-1'],
  difficulty: 3,
  answer_class: null,
  visual_complexity: null,
  draft_status: null,
  variant_depth: 0,
  root_question_id: null,
  parent_variant_id: null,
  parent_question_id: null,
  part_index: null,
  source: 'manual',
  source_ref: null,
  created_by: null,
  metadata: null,
  figures: [],
  image_refs: [],
  structured: null,
  created_at: new Date(),
  updated_at: new Date(),
  version: 0,
} as never);

const CORPUS: Array<{ label: string; value: unknown }> = [
  { label: '完整有效快照', value: VALID_SNAPSHOT },
  {
    label: '仅 4 字段的残缺快照（终轮 P1-1 repro）',
    value: {
      kind: 'short_answer',
      prompt_md: '1+1=?',
      version: 0,
      updated_at: '2026-09-01T00:00:00Z',
    },
  },
  {
    label: '缺 reference_md',
    value: { ...VALID_SNAPSHOT, reference_md: undefined },
  },
  {
    label: '缺 knowledge_ids',
    value: { ...VALID_SNAPSHOT, knowledge_ids: undefined },
  },
  {
    label: 'difficulty 类型错误（字符串）',
    value: { ...VALID_SNAPSHOT, difficulty: '3' },
  },
  {
    label: 'image_refs 类型错误（字符串）',
    value: { ...VALID_SNAPSHOT, image_refs: 'q.png' },
  },
  {
    label: 'version 类型错误（字符串）',
    value: { ...VALID_SNAPSHOT, version: '0' },
  },
  { label: 'null', value: null },
  { label: '空对象', value: {} },
];

describe('FrozenQuestionSnapshot 迁移镜像 ↔ 生产契约 parity', () => {
  it('双方对同一语料 safeParse 同判（accept/reject 完全一致）', () => {
    for (const sample of CORPUS) {
      const production = FrozenQuestionSnapshotSchema.safeParse(sample.value);
      const migration = FrozenQuestionSnapshotMigration.safeParse(sample.value);
      expect(
        production.success === migration.success,
        `parity 漂移于「${sample.label}」：production=${production.success} migration=${migration.success}`,
      ).toBe(true);
    }
  });

  it('生产 freezeQuestionForJudge 产物必须能过迁移镜像（durable 输入端到端）', () => {
    expect(FrozenQuestionSnapshotMigration.safeParse(VALID_SNAPSHOT).success).toBe(true);
  });
});
