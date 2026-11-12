// 内置科目经验文档的种子清单：subject_doc 的 migrate 对账输入。
//
// 文档两类来源——file 原文逐字入库（src/subjects 下已存在的 SKILL.md /
// references / 示例资产，文件只作 seed 输入，运行期真相在表）；profile 由
// SubjectProfile 派生正文（promptFragments / noteTemplate / grounding 的
// prose 不再内嵌进每个任务提示词）。seed_version = 正文内容哈希，改文件或
// 改 profile 都会自然触发升级对账；owner 编辑过的行照旧保留。
//
// doc_key 词表：guide/<主题> 是政策类短文档；skill/<名> 是整篇规范；
// skill/<名>/<子件> 是规范的引用件。general 的文档是所有科目的共享层
// （读侧本科目 miss 后回落 general）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuiltinSubjectId } from './builtin-trait-seeds';
import type { SubjectProfile } from './profile';

export type BuiltinDocSource =
  | { kind: 'file'; path: string }
  | { kind: 'profile'; fields: readonly string[] };

export interface BuiltinDocSeed {
  docKey: string;
  title: string;
  /** 目录行一句话用途；agent 按它决定要不要读正文。 */
  summary: string;
  source: BuiltinDocSource;
}

function teachingGuideBody(profile: SubjectProfile): string {
  const fragments = profile.promptFragments;
  const lines = [
    `- 角色定位：${fragments.roleNoun}`,
    `- 语言风格：${profile.languageStyle}`,
    `- 教学风格：${fragments.teachingStyle}`,
    `- 学习意图改写：${fragments.learningIntentPolicy}`,
  ];
  if (fragments.methodology?.trim()) lines.push(`- 科目方法论：${fragments.methodology}`);
  return lines.join('\n');
}

function groundingGuideBody(profile: SubjectProfile): string {
  return [
    `- 证据要求：${profile.grounding.requirement}`,
    `- 允许来源：${profile.grounding.allowedSources.join('、')}`,
    `- 不确定性纪律：${profile.grounding.uncertaintyPolicy}`,
  ].join('\n');
}

// 与任务提示词同款的五维表渲染；表语义是「用到时写到什么程度」，不是分段模板。
function notesGuideBody(profile: SubjectProfile): string {
  const t = profile.noteTemplate;
  return [
    `- 例题政策：${profile.promptFragments.noteExamplePolicy}`,
    '',
    '笔记五维成稿自查（用到时写到什么程度）：',
    '',
    '| 维度 | 用到时写到什么程度 |',
    '|---|---|',
    `| @definition | ${t.definition} |`,
    `| @mechanism | ${t.mechanism} |`,
    `| @example | ${t.example} |`,
    `| @pitfall | ${t.pitfall} |`,
    `| @check | ${t.check} |`,
  ].join('\n');
}

function questionWritingGuideBody(profile: SubjectProfile): string {
  const fragments = profile.promptFragments;
  const lines = [
    `- 检查题政策：${fragments.checkQuestionPolicy}`,
    `- 变式政策：${fragments.variantExamplePolicy}`,
  ];
  if (fragments.rubricGuidance?.trim()) lines.push(`- 采分点规范：${fragments.rubricGuidance}`);
  return lines.join('\n');
}

const GUIDE_BODY_BUILDERS: Record<string, (profile: SubjectProfile) => string> = {
  'guide/teaching': teachingGuideBody,
  'guide/grounding': groundingGuideBody,
  'guide/notes': notesGuideBody,
  'guide/question-writing': questionWritingGuideBody,
};

const GUIDE_SEEDS: readonly BuiltinDocSeed[] = [
  {
    docKey: 'guide/teaching',
    title: '怎么教这门课',
    summary: '教学角色、语言风格、方法论与学习意图改写',
    source: {
      kind: 'profile',
      fields: [
        'languageStyle',
        'promptFragments.roleNoun',
        'promptFragments.teachingStyle',
        'promptFragments.methodology',
        'promptFragments.learningIntentPolicy',
      ],
    },
  },
  {
    docKey: 'guide/grounding',
    title: '证据与不确定性纪律',
    summary: '结论回到可核查依据、允许来源、材料不足时的处理',
    source: {
      kind: 'profile',
      fields: ['grounding.requirement', 'grounding.allowedSources', 'grounding.uncertaintyPolicy'],
    },
  },
  {
    docKey: 'guide/notes',
    title: '笔记政策与五维自查表',
    summary: '例题政策与五维成稿自查标准（查漏清单，不是分段模板）',
    source: { kind: 'profile', fields: ['promptFragments.noteExamplePolicy', 'noteTemplate'] },
  },
  {
    docKey: 'guide/question-writing',
    title: '出题与变式政策',
    summary: '检查题、变式题与采分点的科目政策',
    source: {
      kind: 'profile',
      fields: [
        'promptFragments.checkQuestionPolicy',
        'promptFragments.variantExamplePolicy',
        'promptFragments.rubricGuidance',
      ],
    },
  },
];

function fileSeed(docKey: string, title: string, summary: string, path: string): BuiltinDocSeed {
  return { docKey, title, summary, source: { kind: 'file', path } };
}

function quizGenPackSeeds(subjectDir: string, packDir: string, title: string, summary: string) {
  const base = `${subjectDir}/skills/${packDir}`;
  return [
    fileSeed(`skill/${packDir}`, title, summary, `${base}/SKILL.md`),
    fileSeed(
      `skill/${packDir}/rubric`,
      `${title} · 评分细则`,
      '判分关注点与采分口径',
      `${base}/references/rubric.md`,
    ),
    fileSeed(
      `skill/${packDir}/anti-patterns`,
      `${title} · 坏题反例`,
      '不合格题型与返工判据',
      `${base}/references/anti-patterns.md`,
    ),
    fileSeed(
      `skill/${packDir}/few-shot`,
      `${title} · 精选范例`,
      '合格题 JSON 范例',
      `${base}/assets/few-shot.json`,
    ),
  ];
}

export const BUILTIN_DOC_SEEDS: Record<BuiltinSubjectId, readonly BuiltinDocSeed[]> = {
  general: [
    ...GUIDE_SEEDS,
    fileSeed(
      'skill/quiz-gen',
      '通用出题方法',
      '题型结构三维框架、题库复用与组卷编排流程',
      '_shared/skills/quiz-gen/SKILL.md',
    ),
  ],
  yuwen: [
    ...GUIDE_SEEDS,
    fileSeed(
      'skill/note',
      '语文笔记写作规范',
      '笔记结构组织、五维内容标准与质检判据',
      'yuwen/skills/note-yuwen/SKILL.md',
    ),
    ...quizGenPackSeeds(
      'yuwen',
      'quiz-gen-translation',
      '翻译题出题与质检规范',
      '翻译题结构描述符、题面与答案语义',
    ),
    ...quizGenPackSeeds(
      'yuwen',
      'quiz-gen-reading-comprehension',
      '阅读理解题出题与质检规范',
      '阅读理解题结构描述符、题面与答案语义',
    ),
  ],
  math: [
    ...GUIDE_SEEDS,
    fileSeed(
      'skill/note',
      '数学笔记写作规范',
      '笔记结构组织、五维内容标准与质检判据',
      'math/skills/note-math/SKILL.md',
    ),
    ...quizGenPackSeeds(
      'math',
      'quiz-gen-calculation',
      '计算题出题与质检规范',
      '计算题结构描述符、题面、采分点与答案格式',
    ),
  ],
  physics: [
    ...GUIDE_SEEDS,
    fileSeed(
      'skill/note',
      '物理笔记写作规范',
      '笔记结构组织、五维内容标准与质检判据',
      'physics/skills/note-physics/SKILL.md',
    ),
  ],
};

const SUBJECTS_ROOT = join(process.cwd(), 'src', 'subjects');

/**
 * 解析 seed 正文：file 逐字读（frontmatter 一并入库，与历史注入内容一致），
 * profile 由字段组合。抛错交调用方（seed 失败是 migrate-fatal）。
 */
export async function resolveBuiltinDocBody(
  seed: BuiltinDocSeed,
  profile: SubjectProfile,
  subjectsRoot: string = SUBJECTS_ROOT,
): Promise<string> {
  if (seed.source.kind === 'file') {
    return readFile(join(subjectsRoot, seed.source.path), 'utf8');
  }
  const builder = GUIDE_BODY_BUILDERS[seed.docKey];
  if (!builder) throw new Error(`no guide body builder for '${seed.docKey}'`);
  return builder(profile);
}

/** seed 来源证明：落 journal detail，文件给路径、profile 给字段清单。 */
export function builtinDocSeedDetail(seed: BuiltinDocSeed): Record<string, unknown> {
  return seed.source.kind === 'file'
    ? { source: 'file', path: seed.source.path }
    : { source: 'profile', fields: [...seed.source.fields] };
}
