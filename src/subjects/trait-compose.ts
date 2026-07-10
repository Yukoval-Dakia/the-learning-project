// YUK-599 (YUK-597 v3 trait 合同 §2.1/§2.2) — SubjectProfile ⇄ 六 trait payload
// 的互逆纯映射 + 装配 version（jt: 身份组合串）。浏览器安全（零 db/server import）。
//
// 「消费点无感」的机械保证：装配（assemble）把六个 trait payload 拼回现有
// SubjectProfile 聚合形状——charter 扁平节映回 languageStyle 顶层 + promptFragments
// 六槽（+ methodology/rubricGuidance 两新字段）；服务端消费点继续拿同一形状。
// 零行为变化基线（v3 §8-13）：assemble(decompose(p)) 与今日 4 个硬编码 profile
// 逐字段 deep-equal，除 version（改 jt: 身份组合串，值语义变化已在 v3 §2.1 成文：
// D6 章从 '1.0.0' 变为 judge 相关身份串）。

import type { SubjectProfile } from './profile-schema';
import type { SubjectTraitPayloads } from './trait-schemas';

export function decomposeProfileToTraitPayloads(profile: SubjectProfile): SubjectTraitPayloads {
  return {
    charter: {
      languageStyle: profile.languageStyle,
      roleNoun: profile.promptFragments.roleNoun,
      noteExamplePolicy: profile.promptFragments.noteExamplePolicy,
      variantExamplePolicy: profile.promptFragments.variantExamplePolicy,
      teachingStyle: profile.promptFragments.teachingStyle,
      checkQuestionPolicy: profile.promptFragments.checkQuestionPolicy,
      learningIntentPolicy: profile.promptFragments.learningIntentPolicy,
      noteTemplate: { ...profile.noteTemplate },
      // 旧对象可能缺两新节（validateProfile 丢弃 parse 产物，运行时对象是原字面量）。
      methodology: profile.promptFragments.methodology ?? '',
      rubricGuidance: profile.promptFragments.rubricGuidance ?? '',
    },
    judge_policy: {
      questionKinds: [...profile.questionKinds],
      judgePolicy: {
        preferredRoutes: [...profile.judgePolicy.preferredRoutes],
        notes: [...profile.judgePolicy.notes],
      },
      judgeCapabilities: [...profile.judgeCapabilities],
    },
    cause_taxonomy: {
      causeCategories: profile.causeCategories.map((c) => ({ ...c })),
    },
    source_policy: {
      grounding: {
        requirement: profile.grounding.requirement,
        allowedSources: [...profile.grounding.allowedSources],
        uncertaintyPolicy: profile.grounding.uncertaintyPolicy,
      },
      sourceWhitelist: [...profile.sourceWhitelist],
      ...(profile.sourcingRoutePreference !== undefined
        ? { sourcingRoutePreference: structuredClone(profile.sourcingRoutePreference) }
        : {}),
      exampleSources: [...profile.exampleSources],
    },
    render_theme: {
      renderConfig: { ...profile.renderConfig },
    },
    scheduling: {
      schedulingHints: structuredClone(profile.schedulingHints),
    },
  };
}

export function assembleSubjectProfile(args: {
  id: string;
  displayName: string;
  // jt: 身份组合串（composeJudgeTraitVersion）；SubjectProfileSchema.version 是
  // 必填 z.string().min(1)（validate-profile 硬校验），组合串满足。
  version: string;
  payloads: SubjectTraitPayloads;
}): SubjectProfile {
  const { charter, judge_policy, cause_taxonomy, source_policy, render_theme, scheduling } =
    args.payloads;
  return {
    id: args.id,
    version: args.version,
    displayName: args.displayName,
    languageStyle: charter.languageStyle,
    questionKinds: [...judge_policy.questionKinds],
    judgePolicy: {
      preferredRoutes: [...judge_policy.judgePolicy.preferredRoutes],
      notes: [...judge_policy.judgePolicy.notes],
    },
    exampleSources: [...source_policy.exampleSources],
    noteTemplate: { ...charter.noteTemplate },
    grounding: {
      requirement: source_policy.grounding.requirement,
      allowedSources: [...source_policy.grounding.allowedSources],
      uncertaintyPolicy: source_policy.grounding.uncertaintyPolicy,
    },
    promptFragments: {
      roleNoun: charter.roleNoun,
      noteExamplePolicy: charter.noteExamplePolicy,
      variantExamplePolicy: charter.variantExamplePolicy,
      teachingStyle: charter.teachingStyle,
      checkQuestionPolicy: charter.checkQuestionPolicy,
      learningIntentPolicy: charter.learningIntentPolicy,
      methodology: charter.methodology,
      rubricGuidance: charter.rubricGuidance,
    },
    causeCategories: cause_taxonomy.causeCategories.map((c) => ({ ...c })),
    renderConfig: { ...render_theme.renderConfig },
    schedulingHints: structuredClone(scheduling.schedulingHints),
    judgeCapabilities: [...judge_policy.judgeCapabilities],
    sourceWhitelist: [...source_policy.sourceWhitelist],
    ...(source_policy.sourcingRoutePreference !== undefined
      ? { sourcingRoutePreference: structuredClone(source_policy.sourcingRoutePreference) }
      : {}),
  };
}

// 装配 version = judge 相关四 trait 的身份组合串（v3 §2.1，装配时计算不落列）。
// 组件 = trait_id@<effective 身份>：正常态 = 数字 live revision；降级链触发时 =
// 实际被采用的身份——journal 回溯 rev（数字）或代码种子合成身份 `seed:<seedVersion>`
// （v3 §2.1④ / owner R2-P1：D6 章永远指向真实生效的配置，不指向没人用过的坏行）。
// render/scheduling 有意不入串（判分无关，免伪信号污染 append-only 证据史）。
export type TraitVersionComponent = { traitId: string; effective: number | `seed:${string}` };

export function composeJudgeTraitVersion(components: {
  charter: TraitVersionComponent;
  judge_policy: TraitVersionComponent;
  cause_taxonomy: TraitVersionComponent;
  source_policy: TraitVersionComponent;
}): string {
  const part = (c: TraitVersionComponent) => `${c.traitId}@${c.effective}`;
  return `jt:${part(components.charter)};${part(components.judge_policy)};${part(components.cause_taxonomy)};${part(components.source_policy)}`;
}
