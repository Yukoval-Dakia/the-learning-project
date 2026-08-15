import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { z } from 'zod';
import { parseTaskJsonObject } from './parse-json';

export const ProfileCriticOutputSchema = z.object({
  review_md: z.string(),
  patches: z.array(
    z.object({
      field: z.string(),
      suggestion: z.string(),
      impact: z.enum(['low', 'minor', 'high']),
    }),
  ),
  blocking: z.boolean(),
});

export type ProfileCriticOutput = z.infer<typeof ProfileCriticOutputSchema>;

export function parseProfileCriticOutput(text: string): ProfileCriticOutput {
  return ProfileCriticOutputSchema.parse(
    parseTaskJsonObject(text, 'ProfileCriticTask', (message, cause) =>
      cause === undefined ? new Error(message) : new Error(message, { cause }),
    ),
  );
}

export const profileCriticTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'ProfileCriticTask',
    description:
      'U7 (YUK-203) — review a draft SubjectProfile for taxonomy/capability/route/prompt/fixture issues. Proposal-only; single-shot, no tools. Input { draft } → strict JSON { review_md, patches[], blocking }.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: {
      kind: 'inline',
      text: '你是 SubjectProfile 评审员。输入是一个**草稿** SubjectProfile（JSON，在 input.draft）。你的工作是审阅这个草稿并提出**改进建议**，绝不直接发布、绝不修改任何文件或数据库（proposal-only）。\n审阅维度：\n- overbroad taxonomy（causeCategories 是否过于宽泛 / 重叠 / 缺关键错因）\n- missing capability（judgeCapabilities 是否覆盖 questionKinds 所需的判分能力）\n- route ambiguity（judgePolicy.preferredRoutes 是否含歧义或与 capabilities 不一致）\n- prompt-template drift（promptFragments / noteTemplate 是否偏离学科教学风格）\n- fixture gap（是否缺少代表性例题来源 exampleSources）\n严格输出 JSON（不要 markdown 代码块包裹），形如：\n{ "review_md": "<人读评审，markdown>", "patches": [{ "field": "<顶层字段名>", "suggestion": "<具体改法>", "impact": "<low|minor|high>" }], "blocking": <true 当存在必须修复的阻断问题，否则 false> }\n只提议，不发布；不要假装已应用任何修改。',
    },
  },
  outputSchema: ProfileCriticOutputSchema,
  parseText: parseProfileCriticOutput,
} satisfies TaskSpec<unknown, ProfileCriticOutput>;
