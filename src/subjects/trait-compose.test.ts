// YUK-599 — trait 分解/装配互逆 + 种子合法性 + strict 写门（v3 合同 §2.1/§6/§8-13）。
//
// 这是「零行为变化」主张的机械基线（v3 §8-13）：assemble(decompose(p)) 与今日
// 4 个硬编码 profile 逐字段 deep-equal（version 走 passthrough 证形状等价；真实
// 装配的 jt: 身份串另行断言格式）。纯函数零 IO —— unit 分区；MUST be listed in
// fastTestInclude（vitest.shared.ts 显式 allowlist）。

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SUBJECT_IDS,
  BUILTIN_TRAIT_SEEDS,
  seedTraitId,
} from './builtin-trait-seeds';
import { subjectProfiles } from './profile';
import {
  assembleSubjectProfile,
  composeJudgeTraitVersion,
  decomposeProfileToTraitPayloads,
} from './trait-compose';
import {
  CharterTraitSchema,
  SUBJECT_TRAIT_KINDS,
  TRAIT_PAYLOAD_SCHEMAS,
} from './trait-schemas';

describe('decompose ⇄ assemble 互逆（v3 §8-13 零行为变化基线）', () => {
  it.each(BUILTIN_SUBJECT_IDS)('%s：assemble(decompose(p)) 逐字段 deep-equal', (subjectId) => {
    const profile = subjectProfiles[subjectId];
    expect(profile, `builtin profile '${subjectId}' 应已注册`).toBeDefined();
    if (!profile) return;
    const reassembled = assembleSubjectProfile({
      id: profile.id,
      displayName: profile.displayName,
      version: profile.version, // passthrough 证形状等价；jt: 串格式另测
      payloads: decomposeProfileToTraitPayloads(profile),
    });
    expect(reassembled).toEqual(profile);
  });

  it('decompose 产物与源 profile 引用隔离（fork 深拷贝独立性前置 ⑫ 的纯函数半）', () => {
    const profile = subjectProfiles.yuwen;
    if (!profile) throw new Error('yuwen profile missing');
    const payloads = decomposeProfileToTraitPayloads(profile);
    // 就地污染分解产物，源 profile 不得被改。
    payloads.charter.noteTemplate.definition = 'MUTATED';
    payloads.judge_policy.questionKinds.push('single_choice');
    payloads.cause_taxonomy.causeCategories[0] = { id: 'MUT', label: 'MUT' } as never;
    expect(profile.noteTemplate.definition).not.toBe('MUTATED');
    expect(profile.questionKinds.at(-1)).not.toBe('single_choice');
    expect(profile.causeCategories[0]?.id).not.toBe('MUT');
  });
});

describe('BUILTIN_TRAIT_SEEDS（v3 §6 种子真相源）', () => {
  it('4 科 × 6 kind 全格在位，payload 全部通过各自 strict 写门 schema', () => {
    for (const subjectId of BUILTIN_SUBJECT_IDS) {
      for (const kind of SUBJECT_TRAIT_KINDS) {
        const seed = BUILTIN_TRAIT_SEEDS[subjectId][kind];
        expect(seed, `${subjectId}.${kind} 种子缺席`).toBeDefined();
        const parsed = TRAIT_PAYLOAD_SCHEMAS[kind].safeParse(seed.payload);
        expect(
          parsed.success,
          `${subjectId}.${kind} 种子未过写门：${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
        ).toBe(true);
        expect(seed.seedVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(seed.payloadSchemaVersion).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('种子 trait id = trt_seed_<subject>_<kind>（migrate 幂等键）', () => {
    expect(seedTraitId('yuwen', 'judge_policy')).toBe('trt_seed_yuwen_judge_policy');
    expect(seedTraitId('general', 'charter')).toBe('trt_seed_general_charter');
  });
});

describe('charter strict 写门（v3 §2.1）', () => {
  const validCharter = () =>
    decomposeProfileToTraitPayloads(
      // biome-ignore lint/style/noNonNullAssertion: builtin 恒在（上组已断言）
      subjectProfiles.general!,
    ).charter;

  it('未知节名 → 拒（.strict()，422 语义）', () => {
    const bad = { ...validCharter(), unknownSection: 'x' };
    expect(CharterTraitSchema.safeParse(bad).success).toBe(false);
  });

  it('methodology/rubricGuidance 缺席 → default 空串；全空两节校验绿（显式无 .min(1)）', () => {
    const { methodology: _m, rubricGuidance: _r, ...withoutNewSections } = validCharter();
    const parsed = CharterTraitSchema.safeParse(withoutNewSections);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.methodology).toBe('');
      expect(parsed.data.rubricGuidance).toBe('');
    }
    const emptyBoth = { ...validCharter(), methodology: '', rubricGuidance: '' };
    expect(CharterTraitSchema.safeParse(emptyBoth).success).toBe(true);
  });

  it('六槽仍 .min(1)（与 profile-schema 逐位一致，未被两新节稀释）', () => {
    const bad = { ...validCharter(), roleNoun: '' };
    expect(CharterTraitSchema.safeParse(bad).success).toBe(false);
  });
});

describe('composeJudgeTraitVersion（jt: 身份组合串，v3 §2.1）', () => {
  it('正常态：id@数字 rev，四组件定序', () => {
    expect(
      composeJudgeTraitVersion({
        charter: { traitId: 'trt_seed_yuwen_charter', effective: 0 },
        judge_policy: { traitId: 'trt_abc', effective: 3 },
        cause_taxonomy: { traitId: 'trt_seed_yuwen_cause_taxonomy', effective: 0 },
        source_policy: { traitId: 'trt_def', effective: 12 },
      }),
    ).toBe('jt:trt_seed_yuwen_charter@0;trt_abc@3;trt_seed_yuwen_cause_taxonomy@0;trt_def@12');
  });

  it('降级态：代码种子兜底用合成身份 id@seed:<seedVersion>（v3 §2.1④）', () => {
    const v = composeJudgeTraitVersion({
      charter: { traitId: 'trt_seed_math_charter', effective: 'seed:1.0.0' },
      judge_policy: { traitId: 'trt_seed_math_judge_policy', effective: 5 },
      cause_taxonomy: { traitId: 'trt_seed_math_cause_taxonomy', effective: 'seed:1.2.0' },
      source_policy: { traitId: 'trt_seed_math_source_policy', effective: 0 },
    });
    expect(v).toContain('trt_seed_math_charter@seed:1.0.0');
    expect(v).toContain('trt_seed_math_cause_taxonomy@seed:1.2.0');
    // SubjectProfileSchema.version 必填 min(1)：组合串恒非空。
    expect(v.length).toBeGreaterThan(3);
  });
});
