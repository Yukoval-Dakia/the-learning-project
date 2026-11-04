import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { quoteAppearsInMessage } from '@/core/steering';
import { event } from '@/db/schema';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import type { DomainTool } from '@/kernel/tools/types';
import { COMMUNICATION_RULES, ChangeResult, TopicPatch } from './topic-contract';
import { changeTopics, readTopics } from './topics';

const RememberInput = TopicPatch.omit({ replaces: true }).extend({
  learner_words: z.string().min(1).max(500),
});
export const rememberLearnerTool: DomainTool<
  z.infer<typeof RememberInput>,
  z.infer<typeof ChangeResult>
> = {
  name: 'remember_learner',
  description: `学习者说出希望记住的偏好、称呼、语气、persona 或个人事实时，回复前调用，确认只用工具实际返回值。learner_words 必须逐字引用本轮原话。${COMMUNICATION_RULES}其他主题自由命名。只记事实，不推断掌握度。不用于学习安排（用 record_steering）。`,
  effect: 'write',
  costClass: 'local',
  mirrorEvent: 'when_causal',
  inputSchema: RememberInput,
  outputSchema: ChangeResult,
  async execute(ctx, input) {
    const anchor = ctx.causedByEventId;
    if (
      !anchor ||
      ctx.derivationPolicy !== 'allow' ||
      (await readEventDerivationPolicy(ctx.db, anchor)) !== 'allow'
    )
      throw new Error('restricted or unbound turn cannot write memory');
    const [ask] = await ctx.db
      .select()
      .from(event)
      .where(and(eq(event.id, anchor), eq(event.actor_kind, 'user')));
    const message = (ask?.payload as { user_message?: unknown })?.user_message;
    if (
      !ask ||
      !['experimental:copilot_user_ask', 'experimental:copilot_chip_trigger'].includes(
        ask.action,
      ) ||
      ask.session_id !== ctx.sessionId ||
      typeof message !== 'string' ||
      !quoteAppearsInMessage(input.learner_words, message)
    )
      throw new Error('memory quote does not belong to current learner turn');
    const { version } = await readTopics(ctx.db);
    return changeTopics(ctx.db, {
      expectedVersion: version,
      actor: 'companion',
      taskRunId: ctx.taskRunId,
      sourceIds: [anchor],
      patches: [{ ...input, replaces: [] }],
    });
  },
  summarize: (_, out) => `记忆：${out.status}`,
};

const CurateInput = z.object({ expected_version: z.number().int(), patches: z.array(TopicPatch) });
export const curateContextTool: DomainTool<
  z.infer<typeof CurateInput>,
  z.infer<typeof ChangeResult>
> = {
  name: 'curate_context',
  description: `直接整理上下文主题：新增事实，或 replaces 指定旧事实 id 做 supersede/merge；全部可撤销。weakness/event 不能 merge，必须逐条 supersede。学习者 correction 优先，不得推翻。只提交有变化的主题，命名自由。${COMMUNICATION_RULES}事实正文禁止添加教学建议、推送安排或下一步计划。证据由服务端本次读取集绑定，不接受模型提供证据 id。无变化就停止。`,
  effect: 'write',
  costClass: 'local',
  mirrorEvent: 'when_causal',
  inputSchema: CurateInput,
  outputSchema: ChangeResult,
  async execute(ctx, input) {
    if (ctx.callerActor.ref !== 'dreaming') throw new Error('Curator-only write');
    const [anchor] = await ctx.db
      .select()
      .from(event)
      .where(eq(event.id, ctx.causedByEventId ?? ''));
    const learnerEdit =
      anchor?.action === 'experimental:context_edit_request' && anchor.actor_kind === 'user';
    const { readCuratorEvidence, readCuratorLegacyScopes } = await import('./curator-evidence');
    const evidence = await readCuratorEvidence(ctx.db, ctx.causedByEventId);
    const scopes = learnerEdit ? [] : await readCuratorLegacyScopes(ctx.db);
    const legacyRefs = scopes.flatMap((s) =>
      s.note
        ? [
            ...s.note.recent_week_evidence_ids,
            ...s.note.recent_months_evidence_ids,
            ...s.note.long_term_evidence_ids,
          ]
        : [],
    );
    return changeTopics(ctx.db, {
      expectedVersion: learnerEdit
        ? z.object({ expected_version: z.number().int() }).parse(anchor.payload).expected_version
        : input.expected_version,
      actor: learnerEdit ? 'learner' : 'curator',
      taskRunId: ctx.taskRunId,
      sourceIds: learnerEdit
        ? [anchor.id]
        : [...new Set([...evidence.map((e) => e.id), ...legacyRefs])],
      patches: input.patches,
    });
  },
  summarize: (_, out) => `整理记忆：${out.status}`,
};
