import { causeIdList, causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { MistakeEnrollOutput, type MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskJsonObject } from './parse-json';

export class MistakeEnrollTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MistakeEnrollTaskError';
  }
}

export function parseMistakeEnrollOutput(text: string): MistakeEnrollOutputT {
  return MistakeEnrollOutput.parse(
    parseTaskJsonObject(
      text,
      'MistakeEnrollTask',
      (message, cause) =>
        new MistakeEnrollTaskError(message, cause === undefined ? undefined : { cause }),
    ),
  );
}

function buildMistakeEnrollPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}错题录入助手。输入 { question_md, reference_md, student_answer_md, allowed_cause_ids, knowledge_ids } —— question_md 是题面文字，reference_md 是参考答案（可能为 null），student_answer_md 是学生的作答（可能为 null / 空），allowed_cause_ids 是本科目允许的错因 id 集合，knowledge_ids 是已确认挂载的知识点。
科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
任务：给这道**已作答**的题草拟录入元数据，供用户一键确认（不是替用户决定）。判定四件事：
1. wrong_answer —— 把 student_answer_md 对照 question_md / reference_md 判一个 outcome：failure（基本错）/ partial（部分对）/ success（基本对）/ unanswered（没作答 / 空白）。
2. question_type —— 从题面判题型：choice | true_false | fill_blank | short_answer | essay | computation | reading | translation | derivation 之一。
3. difficulty —— 1-5 整数难度估计。
4. cause —— **仅当 wrong_answer='failure'** 时给错因草稿（primary_category 必须取自 allowed_cause_ids；secondary_categories 同理；analysis_md 写错答与参考答案的差异 + 涉及概念；confidence 0-1）。其它 outcome 时 cause 给 null。
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 MistakeEnrollOutput：
{"wrong_answer":"failure|partial|success|unanswered","question_type":"<上列之一>","difficulty":1-5,"cause":{"primary_category":"<${causeIdList(profile)} 之一>","secondary_categories":[...],"analysis_md":"...","confidence":0.0-1.0}|null,"overall_confidence":0.0-1.0,"reasoning":"..."}
要点：
- cause 只在 failure 时填，其它 outcome 给 null（运行时也会强制）。
- primary_category 必须是 allowed_cause_ids 之一；吃不准走 other（若存在）或最接近类别（运行时会 clamp 越界值，但请尽量给合法 id）。
- overall_confidence 反映整份草稿的可信度（A2 复查面会用它排序 / 设阈值），吃不准给低分。
- reasoning 具体：引用题面 / 学生答案证据，别空泛。
- 禁止：输出 JSON 之外的文字、用 markdown 代码块包裹整段 JSON、发明 allowed_cause_ids 之外的错因。`;
}

export const mistakeEnrollTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'MistakeEnrollTask',
    description:
      'T-OC slice A1 (YUK-145, OC-5) — 给一道已作答的录入题草拟错题元数据：判定 outcome（failure/partial/success/unanswered）+ 题型 + 难度 + （错答时）错因。单次结构化输出，非 multimodal。observe-only：草稿挂到 auto_enroll_observed 审计事件，不写 domain 行（enroll flag OFF）。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildMistakeEnrollPrompt },
  },
  outputSchema: MistakeEnrollOutput,
  parseText: parseMistakeEnrollOutput,
} satisfies TaskSpec<unknown, MistakeEnrollOutputT>;
