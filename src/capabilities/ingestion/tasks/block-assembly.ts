import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';
import { parseTaskJsonObject } from './parse-json';

export const BlockAssemblyCandidate = z.object({
  primary_block_id: z.string().min(1),
  merge_block_ids: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  signal: z.enum(['page_edge', 'numbering', 'stem_answer_split', 'carryover']),
  reason_md: z.string(),
});
export type BlockAssemblyCandidateT = z.infer<typeof BlockAssemblyCandidate>;

export const BlockAssemblyOutput = z.object({
  candidates: z.array(BlockAssemblyCandidate).default([]),
});
export type BlockAssemblyOutputT = z.infer<typeof BlockAssemblyOutput>;

export class BlockAssemblyTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlockAssemblyTaskError';
  }
}

export function parseBlockAssemblyOutput(text: string): BlockAssemblyOutputT {
  return BlockAssemblyOutput.parse(
    parseTaskJsonObject(
      text,
      'BlockAssemblyTask',
      (message, cause) =>
        new BlockAssemblyTaskError(message, cause === undefined ? undefined : { cause }),
    ),
  );
}

function buildBlockAssemblyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}试卷录入的「题块装配」助手。输入 { ingestion_session_id, blocks: [{ block_id, question_no, prompt_head, role, sub_question_count, layout_quality[, page_index] }] } —— blocks 是同一次录入抽取出的全部草稿题块，**按数组顺序排列（数组相邻 = 题块相邻）**。每块给的是结构化文字投影：question_no（题号，可能为 null）、prompt_head（题面开头文字）、role（stem/sub/standalone）、sub_question_count（子问数）、layout_quality。page_index（若存在）是该块所在页（0-based），可作为辅助空间信号。
科目上下文：${profile.displayName}。${profile.languageStyle}
任务：找出哪些**相邻**题块其实是**同一道逻辑题被切开**了，应该合并。判据：
- **编号连续**：question_no 连续（如 5 接 6 的子问，或同一大题被拆成两块）。
- **子问承接**：前一块是大题/题干，后一块只有 (1)(2)(3) 这样的子问延续。
- **题干答案分离**：一块是题干，紧邻的下一块只有答案/解析，没有独立题面。
- **上下文承接提示**：后一块出现「承接前题」「根据上文」「续上」等线索词。
- **页码连续（仅当 page_index 存在时）**：相邻块 page_index 连续（如 0→1），且语义线索与跨页切断一致，可佐证 page_edge 信号。
重要约束：语义线索是主判据；page_index 仅为辅助。**若 page_index 不在输入里，纯用语义判断**（Tencent 路径无空间信号）。不要依赖 bbox / 像素位置。
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 BlockAssemblyOutput：
{"candidates":[{"primary_block_id":"<保留结构树的主块 id>","merge_block_ids":["<折叠进主块的相邻块 id>", "..."],"confidence":0.0-1.0,"signal":"page_edge"|"numbering"|"stem_answer_split"|"carryover","reason_md":"<具体说明哪条连续线索 + 引用 question_no / 题面证据>"}]}
要点：
- primary_block_id 与 merge_block_ids 都必须是输入 blocks 里真实存在的 block_id；merge_block_ids 至少 1 个，且不含 primary 自己。
- 同一个 block 不要出现在多个候选里（一个块只属于一次合并）。
- signal 选最贴切的那条线索；page_edge 代表跨页切断，仅在 page_index 信号佐证时使用。
- confidence 反映你对「这几块确实是一道题」的把握；吃不准就给低分（下游只是 propose，用户会复核，但别凑数）。
- reason_md 必须具体：引用 question_no、题面文字或数组位置（如「第 N 块」），说清为什么该合并；这是用户可见文案，**禁止写入 block_id 或其他不透明 ID**。
- **宁缺毋滥**：没有明确该合并的相邻块时，输出空 candidates。禁止套话、禁止 JSON 之外的文字。`;
}

export const blockAssemblyTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'BlockAssemblyTask',
    description:
      'YUK-202 / BlockAssembly path-B (design 2026-06-02 §2) — 给一个 ingestion session 的全部 draft blocks（按数组顺序 = 相邻关系）的紧凑文字投影（question_no / prompt 头 / role / 子问数 / layout_quality），找出哪些相邻 block 其实是被切开的同一道逻辑题（编号连续 / 子问承接 / 题干答案分离 / "承接前题、根据上文" 提示），输出 BlockAssemblyOutput 候选。单次结构化输出，输入是结构化文字（非页面图片）→ NON-vision，走 TaggingTask 同档轻量模型。SEMANTIC-ONLY：spatial/bbox page-edge 信号 DEFERRED 到 slice 2b（§0）。AI 只 propose 不 auto-merge（§5 硬边界）；候选经 writeBlockMergeProposal 落 inbox，用户接受才跑 mergeQuestions。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildBlockAssemblyPrompt },
  },
  outputSchema: BlockAssemblyOutput,
  parseText: parseBlockAssemblyOutput,
} satisfies TaskSpec<unknown, BlockAssemblyOutputT>;
