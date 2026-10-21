import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { pendingProposalWithCooldown } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  EditQuestionInput,
  probeDraftEdit,
  saveDraftEdit,
  validateDraftEdit,
} from './submit-question';

// ====================================================================
// edit_question DomainTool（统一题目编辑面）
// ====================================================================
// actions：
// save — document（创建新草稿）XOR ops（对 draft_ref / question_id 局改）。
// CAS：expected_draft_version + expected_revision；request_id 幂等。
// validate — 纯本地校验（四层契约 validators + 引用完整性），不写。
// probe — 显式合成作答走 evaluateSubmissionCore 同一入口；不落
// attempt/candidate/settlement；模型方法未准入如实未决。
// 面权限（服务端判定，非入参）：Copilot 面（agent:copilot*）的 save 一律落
// question_edit proposal（用户 accept 后 accept applier 走同一 ops → submit
// 管线）；其它 surface 直写授权草稿。validate/probe 对 Copilot 直出（无写）。

const inputSchema = EditQuestionInput;

// 输出按 status 分派；receipt 字段随状态裁剪（zod 边界防 drift，不含敏感字段）。
const issueSchema = z.object({
  code: z.string(),
  detail: z.string(),
  part_id: z.string().optional(),
  unit_id: z.string().optional(),
  locations: z.array(z.object({ offset: z.number() })).optional(),
});

const changeSchema = z.object({
  op: z.string(),
  target: z.unknown(),
  fields: z.array(z.string()),
  identity_remap: z.object({ from: z.string(), to: z.string() }).optional(),
});

const invalidatedSchema = z.object({
  solve_units: z.array(z.string()),
  calibration_units: z.array(z.string()),
  rule_verification_units: z.array(z.string()),
  retrieval_fields: z.array(z.string()),
  display_parts: z.array(z.string()),
  presentation_validation: z.boolean(),
});

const outputSchema = z.object({
  status: z.enum([
    'saved',
    'noop',
    'conflict',
    'rejected',
    'validated',
    'invalid',
    'probed',
    'proposed',
  ]),
  draft_ref: z.string().optional(),
  draft_version: z.number().optional(),
  question_id: z.string().optional(),
  current_published_ref: z.string().nullable().optional(),
  changes: z.array(changeSchema).optional(),
  publishable: z.boolean().optional(),
  issues: z.array(issueSchema).optional(),
  invalidated: invalidatedSchema.optional(),
  request_id: z.string().optional(),
  replayed: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  current_draft_ref: z.string().optional(),
  current_draft_version: z.number().optional(),
  current_revision_ref: z.string().nullable().optional(),
  cases: z
    .array(
      z.object({
        probe_id: z.string(),
        unit_id: z.string().optional(),
        actual: z.unknown(),
        expected: z.unknown(),
        matches: z.boolean().nullable(),
        method_fingerprint: z.string(),
        run_refs: z.array(z.string()),
      }),
    )
    .optional(),
  admission_granted: z.boolean().optional(),
  run_ref: z.string().optional(),
  proposal_id: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

function isCopilotCaller(ctx: ToolContext): boolean {
  if (ctx.callerActor.kind !== 'agent') return false;
  const bare = ctx.callerActor.ref.replace(/^agent:/i, '').toLowerCase();
  return bare === 'copilot' || bare === 'copilot_chip' || bare.startsWith('copilot:');
}

/**
 * Copilot save → question_edit proposal（同 edit_question 契约；accept 时重放
 * ops → submit gate）。提案只携带请求本身 —— 不先物化草稿（accept 时才
 * 播种 + CAS 校验，过期 revision 如实 409）。
 */
async function proposeEditRequest(ctx: ToolContext, input: Input): Promise<Output> {
  const questionId =
    input.question_id ??
    (input.draft_ref != null ? await resolveDraftQuestionId(ctx, input.draft_ref) : null);
  const cooldownKey = `question_edit:${questionId ?? 'draft'}:${hashOps(input)}`;
  if (await pendingProposalWithCooldown(ctx.db, 'question_edit', cooldownKey)) {
    return {
      status: 'rejected',
      reason: 'duplicate_pending',
      detail: 'an identical edit proposal is already pending',
    };
  }
  const proposalId = await writeAiProposal(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    payload: {
      kind: 'question_edit',
      target: { subject_kind: 'question', subject_id: questionId ?? 'draft' },
      reason_md: `edit_question ops on ${questionId ?? 'new draft'}`,
      evidence_refs: questionId != null ? [{ kind: 'question', id: questionId }] : [],
      proposed_change: {
        ...(questionId != null ? { question_id: questionId } : {}),
        edit_request: {
          ops: input.ops,
          document: input.document,
          draft_ref: input.draft_ref,
          expected_revision: input.expected_revision,
          expected_draft_version: input.expected_draft_version,
        },
      },
      rollback_plan: {
        action: 'dismiss proposal; the draft/published question is unchanged',
      },
      cooldown_key: cooldownKey,
      suggestion_kind: 'proactive',
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
  return { status: 'proposed', proposal_id: proposalId };
}

function hashOps(input: Input): string {
  // 同内容 ⇒ 同 proposal cooldown key（幂等配对），用 sha256 抗碰撞。
  const canonical = JSON.stringify({ ops: input.ops, document: input.document });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

async function resolveDraftQuestionId(ctx: ToolContext, draftRef: string): Promise<string | null> {
  const parts = draftRef.split(':');
  if (parts.length !== 3) return null;
  const { question_block } = await import('@/db/schema');
  const [block] = await ctx.db
    .select({ imported_question_id: question_block.imported_question_id })
    .from(question_block)
    .where(eq(question_block.id, parts[1]))
    .limit(1);
  return block?.imported_question_id ?? null;
}

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = inputSchema.parse(raw);
  const serviceCtx = {
    actorRef: ctx.callerActor.ref,
    actorKind: 'agent' as const,
    taskRunId: ctx.taskRunId,
  };
  if (input.action === 'validate') {
    return (await validateDraftEdit(ctx.db, { input, ctx: serviceCtx })) as Output;
  }
  if (input.action === 'probe') {
    const probes = input.probes ?? [];
    if (probes.length === 0) {
      return {
        status: 'rejected',
        reason: 'probe requires at least one probe case',
        detail: 'probes[] is empty',
      };
    }
    return (await probeDraftEdit(ctx.db, {
      input,
      ctx: { ...serviceCtx, sessionId: ctx.sessionId },
      probes,
    })) as Output;
  }
  // save —— surface 权限决定 direct vs proposal。
  if (isCopilotCaller(ctx)) {
    return proposeEditRequest(ctx, input);
  }
  return (await saveDraftEdit(ctx.db, { input, ctx: serviceCtx })) as Output;
}

export const editQuestionTool: DomainTool<Input, Output> = {
  name: 'edit_question',
  description:
    '统一题目编辑面（schema_version-2 草稿文档）。action="save"：document 创建新草稿，或 ops 对 draft_ref/question_id 做局部编辑（set/clear/add/remove/replace_all/replace_text/set_metadata/unset_metadata/move；按稳定 id 寻址）。expected_draft_version + expected_revision 做 CAS；request_id 幂等重放。action="validate"：纯本地契约校验不写。action="probe"：合成作答走统一判分入口（确定性方法出实判，模型方法未准入如实未决）。返回 draft_ref/draft_version、changed fields、publishable+issues 与失效域。保存的是不完整但诚实的草稿；发布走 submit_question。',
  effect: 'write',
  inputSchema,
  outputSchema,
  costClass: 'local',
  execute,
  summarize(input, output) {
    return `edit_question[${input.action}] ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
