import { UNIVERSAL_RATING_POLICY } from '@/core/schema/profile-decl';
import type { SubjectProfile } from '../profile';

export const mathProfile: SubjectProfile = {
  id: 'math',
  version: '1.0.0',
  displayName: '数学',
  languageStyle: '中文讲解，强调定义、条件、推导步骤和符号一致性。',
  questionKinds: [
    'single_choice',
    'multiple_choice',
    'short_answer',
    'calculation',
    'proof',
    'word_problem',
  ],
  judgePolicy: {
    preferredRoutes: ['exact', 'keyword', 'steps', 'semantic', 'ai_flexible'],
    notes: [
      '最终答案可用 exact / keyword 初筛。',
      '推导题和证明题后续接入 steps / rubric。',
      '含公式渲染的题目由 renderConfig.notation 指定 katex。',
    ],
  },
  exampleSources: ['题面条件', '教材定义', '公式定理', '用户解题步骤'],
  noteTemplate: {
    definition: '写清定义、适用条件和符号含义。',
    mechanism: '拆解公式来源、变形依据和解题策略。',
    example: '给出带步骤的短例题，保留关键中间式。',
    pitfall: '列出易漏条件、计算错误和方法误选。',
    check: '给出一个同类小题或一步推导检查。',
  },
  grounding: {
    requirement: '推导必须能追溯到题面条件、定义、定理或用户已有步骤。',
    allowedSources: ['user_material', 'textbook', 'formula_sheet', 'llm_prior'],
    uncertaintyPolicy: '条件不足时指出缺少的条件，不默认补题。',
  },
  promptFragments: {
    roleNoun: '数学学习教练',
    noteExamplePolicy: '例题必须标出条件、目标和每一步变形依据。',
    variantExamplePolicy: '变式题保持同一核心方法，同时改变数值或条件组合。',
    teachingStyle: '先检查条件和目标，再给推导路径，最后总结方法触发信号。',
    checkQuestionPolicy: '检查题应聚焦一个公式、条件判断或关键变形。',
    learningIntentPolicy: '把模糊目标改写成可练习的题型、知识点或解题步骤。',
    // YUK-599 — charter trait 两新节的种子 = 空串（v3 §6；写门 default('') 同义，
    // 此处显式写出保持 profile 对象 = schema 输出形状的逐字段等价）。
    methodology: '',
    rubricGuidance: '',
  },
  causeCategories: [
    {
      id: 'concept',
      label: '概念理解',
      description: '对数学定义、定理、条件的理解错误',
      review_priority: 5,
      // YUK-739 — subject-owned evaluation semantics (moved off cross-subject mirrors).
      meta_cause_prior: 'flawed_model',
      rating_lean: 'conceptual',
      variant_strategy: '同概念不同语境 / 反向考查（验证概念边界）',
    },
    {
      id: 'knowledge_gap',
      label: '知识缺失',
      description: '缺少解题所需的数学知识',
      review_priority: 4,
      meta_cause_prior: 'knowledge_gap',
      variant_strategy: '补充该知识点的典型变体',
    },
    {
      id: 'calculation',
      label: '运算错误',
      description: '代数计算、数值运算失误',
      review_priority: 3,
      meta_cause_prior: 'execution_slip',
      variant_strategy: '改数据 + 留同样陷阱（验证计算稳定性）',
    },
    {
      id: 'method',
      label: '方法选择',
      description: '解题方法或策略选择不当',
      review_priority: 4,
      meta_cause_prior: 'rule_misapplication',
      variant_strategy: '提示备选方法 + 同类型题',
    },
    {
      id: 'reading',
      label: '审题偏差',
      description: '题面条件遗漏或误读',
      review_priority: 3,
      meta_cause_prior: 'representation_failure',
      variant_strategy: '改提问方式 + 加干扰信息',
    },
    {
      id: 'memory',
      label: '记忆混淆',
      description: '公式、定理的记忆不准确',
      review_priority: 3,
      meta_cause_prior: 'retrieval_failure',
      variant_strategy: '不同表述测同一记忆点',
    },
    {
      id: 'expression',
      label: '表达不规范',
      description: '推导步骤省略或书写不清',
      review_priority: 3,
      meta_cause_prior: 'representation_failure',
      variant_strategy: '同题重写答案要求（重点检查表达）',
    },
    {
      id: 'unit_error',
      label: '单位错误',
      description: '量纲或单位换算错误',
      review_priority: 2,
      meta_cause_prior: 'execution_slip',
      variant_strategy: '改变单位、量纲或换算条件，检查单位一致性',
    },
    {
      id: 'carelessness',
      label: '粗心',
      description: '非知识性的计算笔误或抄写错误',
      review_priority: 2,
      variant_targetable: false,
      meta_cause_prior: 'execution_slip',
      rating_lean: 'carelessness',
    },
    {
      id: 'time_pressure',
      label: '时间压力',
      description: '限时条件下步骤选择、节奏或计算稳定性下降',
      review_priority: 2,
      variant_targetable: true,
      meta_cause_prior: 'execution_slip',
    },
    {
      id: 'other',
      label: '其它',
      review_priority: 2,
      variant_targetable: false,
      meta_cause_prior: null,
    },
  ],
  // YUK-739 — verdict → FSRS rating mapping is profile-owned; math declares the
  // universal 3-state mapping explicitly (FSRS surface is subject-agnostic today).
  ratingPolicy: UNIVERSAL_RATING_POLICY,
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  // M2.1 (2026-05-22): + 'steps' for derivation question kind.
  // steps@1 capability is registered in default registry; run() body lands in M2.2.
  // YUK-201: + 'multimodal_direct' so it is available as a judge_kind_override on
  // math questions (override path). NOT added to preferredRoutes — steps@1 owns
  // math derivations; math does not auto-route to multimodal_direct.
  judgeCapabilities: ['exact', 'keyword', 'semantic', 'steps', 'multimodal_direct'],
  // YUK-225 (S2 slice 4) — OF-1 首批源白名单候选 (调研报告
  // .omc/research/2026-06-05-source-whitelist-candidates.md, owner review pending).
  //   gaokao.eol.cn      — 中国教育在线·掌上高考, 历年高考数学真题+解析, 官方媒体 / 无登录,
  //                        覆盖 2010–2025 (形态: 真题多图片嵌入, OCR 抽取有难度)。
  //   gaokao.zxxk.com    — 学科网高考专项子站 (形态: 登录边界待 owner 人工确认)。
  //   gaokao.neea.edu.cn — 教育部中国教育考试网, 权威性最高 (形态: 试题评析文章非题库, SSL 不稳)。
  //   www.jyeoo.com — 菁优网 (YUK-697): jyeoo-rs 确定性题源 producer host。加入白名单使
  //                   jyeoo_fetch 抓取的题 whitelist_match=true (选题排序不降权)。
  sourceWhitelist: ['gaokao.eol.cn', 'gaokao.zxxk.com', 'gaokao.neea.edu.cn', 'www.jyeoo.com'],
  // 计算题优先找现成真题, 不足凭知识闭卷出 / 变式扩展。
  sourcingRoutePreference: {
    calculation: ['sourced', 'closed_book', 'variant'],
  },
  // YUK-697 — 数学有 jyeoo-rs 确定性题源。'math2' = 菁优网站内 subject 词表 (高中数学)。
  // 声明即 supply dispatcher 在数学 tier-2 缺口上优先 jyeoo_fetch (route-planner)，
  // 派发受 JYEOO_FETCH_ENABLED kill switch 控 (默认 OFF → 回退 sourcing_web)。
  jyeooSupply: { subject: 'math2' },
};
