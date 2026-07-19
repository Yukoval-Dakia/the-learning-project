// YUK-599 (YUK-597 v3 trait 合同 §6) — 种子真相源 BUILTIN_TRAIT_SEEDS。
//
// payload 从现有 4 个代码 profile 在模块加载期分解生成（decompose 单一来源，
// 代码 profile 改动自动进种子——但**传播到 DB 行必须 bump 对应格子的 seedVersion**：
// migrate 的 reconcileBuiltinTraits 以「代码种子 semver ≠ 行 seed_version」为唯一
// 升级触发信号，内容改了不 bump = 不传播（v3 §6，纯内容改动 bump 即传播，Zod 形状
// 不变也能升级）。相等 → 整行硬跳过（重跑零副作用）。
//
// seedVersion per (subject, kind) 独立（bump charter 不虚触发其他 kind 的
// reconcile）；初值各 '1.0.0'。种子 trait id = trt_seed_<subject>_<kind>
// （migrate 幂等键）。charter 的 methodology/rubricGuidance 种子 = 空串
// （profile 文件里显式写出）。

import { subjectProfiles } from './profile';
import { decomposeProfileToTraitPayloads } from './trait-compose';
import {
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
  TRAIT_PAYLOAD_SCHEMA_VERSIONS,
} from './trait-schemas';

export const BUILTIN_SUBJECT_IDS = ['general', 'yuwen', 'math', 'physics'] as const;
export type BuiltinSubjectId = (typeof BUILTIN_SUBJECT_IDS)[number];

// bump 点：改了某科某 kind 的种子内容，就 bump 这里对应格子（例：yuwen charter
// 教学风格改词 → yuwen.charter '1.0.0' → '1.1.0'，migrate 下次重跑即覆盖升级
// 未被 owner 编辑的行 + journal 'reconcile'）。
export const BUILTIN_TRAIT_SEED_VERSIONS: Record<
  BuiltinSubjectId,
  Record<SubjectTraitKind, string>
> = {
  general: {
    charter: '1.0.0',
    judge_policy: '1.0.0',
    cause_taxonomy: '1.0.0',
    source_policy: '1.0.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
  yuwen: {
    charter: '1.0.0',
    judge_policy: '1.0.0',
    cause_taxonomy: '1.0.0',
    source_policy: '1.0.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
  math: {
    charter: '1.0.0',
    judge_policy: '1.0.0',
    cause_taxonomy: '1.0.0',
    // YUK-697 — bumped from 1.0.0: math source_policy gained jyeooSupply + the www.jyeoo.com
    // whitelist. Without this bump, reconcileBuiltinTraits sees an unchanged seed_version on
    // already-deployed subject_trait rows and hard-skips, so a hydrated instance would never
    // pick up jyeooSupply (JYEOO_FETCH_ENABLED=1 would still route to sourcing_web). The bump
    // makes reconcile upgrade the row (unless owner-edited) so the new field propagates.
    source_policy: '1.1.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
  physics: {
    charter: '1.0.0',
    judge_policy: '1.0.0',
    cause_taxonomy: '1.0.0',
    source_policy: '1.0.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
};

export interface BuiltinTraitSeed {
  payload: unknown;
  seedVersion: string;
  payloadSchemaVersion: number;
}

export function seedTraitId(subjectId: BuiltinSubjectId, kind: SubjectTraitKind): string {
  return `trt_seed_${subjectId}_${kind}`;
}

function buildSeeds(): Record<BuiltinSubjectId, Record<SubjectTraitKind, BuiltinTraitSeed>> {
  const out = {} as Record<BuiltinSubjectId, Record<SubjectTraitKind, BuiltinTraitSeed>>;
  for (const subjectId of BUILTIN_SUBJECT_IDS) {
    const profile = subjectProfiles[subjectId];
    if (!profile) {
      // 四 builtin 是编译期常量（registry 构造器注册）；缺席 = 构建配置坏，fail fast。
      throw new Error(`BUILTIN_TRAIT_SEEDS: builtin profile '${subjectId}' is not registered`);
    }
    const payloads = decomposeProfileToTraitPayloads(profile);
    out[subjectId] = {} as Record<SubjectTraitKind, BuiltinTraitSeed>;
    for (const kind of SUBJECT_TRAIT_KINDS) {
      out[subjectId][kind] = {
        payload: payloads[kind],
        seedVersion: BUILTIN_TRAIT_SEED_VERSIONS[subjectId][kind],
        payloadSchemaVersion: TRAIT_PAYLOAD_SCHEMA_VERSIONS[kind],
      };
    }
  }
  return out;
}

export const BUILTIN_TRAIT_SEEDS = buildSeeds();
