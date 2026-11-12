import { z } from 'zod';
import { BacktraceView } from '@/core/schema/backtrace';
import type { DomainTool } from '@/kernel/tools/types';
import { readBacktrace } from '../server/backtrace-read';

const Output = BacktraceView.extend({ claim_boundaries: z.array(z.string()) });
const Input = z.object({
  attempt_event_id: z.string().optional(),
  question_id: z.string().optional(),
  want: z.enum(['mistakes', 'solutions', 'both']).optional(),
  limit: z.number().int().min(1).max(5).optional(),
});
export const backtraceTool: DomainTool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'backtrace',
  description:
    '回看本人以前相似的具体错法和解法。仅返回可见、有效且获准派生的记录；没有描述或仍在准备时如实报告状态。不能由相似性推断掌握程度。',
  effect: 'read',
  inputSchema: Input,
  outputSchema: Output,
  costClass: 'local',
  mirrorEvent: 'when_user_visible',
  summarize: (_input, output) => `backtrace · ${output.status}`,
  async execute(ctx, input) {
    const result = await readBacktrace(ctx.db, {
      ...input,
      session_id: !input.attempt_event_id && !input.question_id ? ctx.sessionId : undefined,
    });
    const limit = input.limit ?? 5;
    return {
      ...result,
      claim_boundaries: [
        '相似性不证明掌握程度或相同错因；以本人记录和具体步骤为据。',
        '次数和错误率只统计当前获准派生、可见的同题有效历史。',
      ],
      similar_mistakes: input.want === 'solutions' ? [] : result.similar_mistakes.slice(0, limit),
      similar_solutions: input.want === 'mistakes' ? [] : result.similar_solutions.slice(0, limit),
      broader: result.broader.slice(0, limit),
    };
  },
};
