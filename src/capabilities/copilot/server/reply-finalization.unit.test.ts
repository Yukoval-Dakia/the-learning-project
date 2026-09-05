import { createHash } from 'node:crypto';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { writeCopilotReply } from './chat';
import { createCopilotReplyFinalizer } from './reply-finalization';
import { REALISTIC_EVIDENCE_TRACE } from './reply-finalization.actual-fixture';

const correctionContract = {
  available_prior_turn_ids: [] as string[],
  prior_turn_summaries: {},
  required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'] as const,
};

function finalizer(
  validateLearningContent: Parameters<
    typeof createCopilotReplyFinalizer
  >[0]['validateLearningContent'] = async (text) => ({ replyText: text, passed: true }),
) {
  return createCopilotReplyFinalizer({
    rootTaskRunId: 'root_run_1',
    correctionContract,
    userContextText: '用户正在核对一条复杂学习链。',
    validateLearningContent,
  });
}

function preHook(value: ReturnType<typeof finalizer>): HookCallback {
  return value.hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
}

async function pre(
  value: ReturnType<typeof finalizer>,
  toolName: string,
  toolUseId: string,
  input: unknown,
  agentId?: string,
) {
  return preHook(value)(
    {
      hook_event_name: 'PreToolUse',
      session_id: 'session_1',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp',
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: input,
      ...(agentId ? { agent_id: agentId } : {}),
    },
    toolUseId,
    { signal: new AbortController().signal },
  );
}

describe('Copilot root reply finalization', () => {
  it('seals one plain reply and binds the exact persisted bytes to its receipt', async () => {
    const value = finalizer();
    const result = await value.finalizeTerminal(
      JSON.stringify({ reply_md: '已整理为 3 个要点。', relied_on_tool_use_ids: [] }),
    );

    expect(result).toMatchObject({ accepted: true, replyText: '已整理为 3 个要点。' });
    expect(result.receipt).toMatchObject({
      assurance: 'root_attested_structural',
      trace_call_count: 0,
      learning_content: 'not_applicable',
    });
    expect(result.receipt.reply_sha256).toBe(
      createHash('sha256').update(result.replyText, 'utf8').digest('hex'),
    );
  });

  it('accepts the actual provider suffix fence only when duplicated prose equals reply_md', async () => {
    const value = finalizer();
    const toolUseId = 'call_8af33fd439f3473cbeb37a32';
    await pre(value, 'mcp__loom__query_knowledge', toolUseId, {
      subjectId: 'yuwen',
      nodeId: 'actual:classical-root',
      include: ['children'],
      limit: 10,
    });
    value.observeDomainTool({
      tool_use_id: toolUseId,
      name: 'query_knowledge',
      effect: 'read',
      input: { subjectId: 'yuwen', nodeId: 'actual:classical-root' },
      output: {
        nodes: [
          { id: 'actual:classical-root', name: '文言虚词「之」' },
          { id: 'actual:classical-object', name: '代词宾语用法' },
        ],
      },
      error_reason: null,
      executed: true,
    });
    const reply = [
      '工具实际返回了 2 个节点，名称如下：',
      '',
      '1. **文言虚词「之」**（id: `actual:classical-root`，无父节点）',
      '2. **代词宾语用法**（id: `actual:classical-object`，父节点为「文言虚词「之」」）',
    ].join('\n');
    const terminal = [
      reply,
      '',
      '```json',
      JSON.stringify({ reply_md: reply, relied_on_tool_use_ids: [toolUseId] }),
      '```',
    ].join('\n');

    const result = await value.finalizeTerminal(terminal);

    expect(result).toMatchObject({ accepted: true, replyText: reply });
    expect(result.receipt.relied_on_tool_use_ids).toEqual([toolUseId]);
  });

  it('accepts a sole JSON fence without treating the fence as reply prose', async () => {
    const value = finalizer();
    const result = await value.finalizeTerminal(
      ['```json', '{"reply_md":"仅围栏正文","relied_on_tool_use_ids":[]}', '```'].join('\n'),
    );

    expect(result).toMatchObject({ accepted: true, replyText: '仅围栏正文' });
  });

  it('persists exactly the sealed bytes and compact receipt on the shared inline/durable writer', async () => {
    const value = finalizer();
    const finalized = await value.finalizeTerminal(
      JSON.stringify({ reply_md: '已整理为 3 个要点。', relied_on_tool_use_ids: [] }),
    );
    const writes: Array<Record<string, unknown>> = [];
    await writeCopilotReply({} as never, {
      sessionId: 'session_1',
      userAskEventId: 'ask_1',
      replyText: finalized.replyText,
      preparedReply: finalized.preparedReply,
      actorRef: 'agent:copilot',
      taskRunId: 'root_run_1',
      replyFinalization: finalized.receipt,
      now: new Date('2026-09-05T08:00:00Z'),
      writeFn: async (_db, event) => {
        writes.push(event as unknown as Record<string, unknown>);
        return 'reply_1';
      },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload).toMatchObject({
      reply_md: finalized.replyText,
      reply_finalization: finalized.receipt,
    });
    await expect(
      writeCopilotReply({} as never, {
        sessionId: 'session_1',
        replyText: `${finalized.replyText}尾随 prose`,
        preparedReply: { text: `${finalized.replyText}尾随 prose` },
        actorRef: 'agent:copilot',
        taskRunId: 'root_run_1',
        replyFinalization: finalized.receipt,
        now: new Date('2026-09-05T08:00:00Z'),
        writeFn: async () => 'unreachable',
      }),
    ).rejects.toThrow(/digest does not match persisted bytes/);
  });

  it('accepts only distinct, settled, successful current-root provenance ids', async () => {
    const value = finalizer();
    await pre(value, 'mcp__loom__query_events', 'tool_1', { subjectId: 'A01' });
    await pre(value, 'mcp__loom__query_events', 'tool_2', { subjectId: 'A01' });
    await pre(value, 'mcp__loom__query_events', 'foreign_1', { subjectId: 'A03' }, 'child_1');
    value.observeDomainTool({
      tool_use_id: 'tool_1',
      name: 'query_events',
      effect: 'read',
      input: { subjectId: 'A01' },
      output: { events: [{ id: 'event_1', created_at: '2026-09-05T08:00:00Z' }] },
      error_reason: null,
      executed: true,
    });
    value.observeDomainTool({
      tool_use_id: 'foreign_1',
      name: 'query_events',
      effect: 'read',
      input: { subjectId: 'A03' },
      output: { events: [] },
      error_reason: null,
      executed: true,
    });
    value.observeDomainTool({
      tool_use_id: 'tool_2',
      name: 'query_events',
      effect: 'read',
      input: { subjectId: 'A01' },
      output: { events: [{ id: 'event_2', created_at: '2026-09-05T08:00:01Z' }] },
      error_reason: 'provider failed',
      executed: true,
    });

    for (const ids of [['tool_2'], ['foreign_1'], ['tool_1', 'tool_1']]) {
      const rejected = await value.finalizeTerminal(
        JSON.stringify({ reply_md: '核对完成。', relied_on_tool_use_ids: ids }),
      );
      expect(rejected.accepted).toBe(false);
    }
    const accepted = await value.finalizeTerminal(
      JSON.stringify({ reply_md: '核对完成。', relied_on_tool_use_ids: ['tool_1'] }),
    );
    expect(accepted.receipt).toMatchObject({
      trace_call_count: 3,
      relied_on_tool_use_ids: ['tool_1'],
      primary_view: 'absent',
    });
  });

  it('rejects a terminal envelope when the trace changes during validation', async () => {
    let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let enterValidation!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterValidation = resolve;
    });
    const value = finalizer(async (text) => {
      enterValidation();
      await validationStarted;
      return { replyText: text, passed: true };
    });
    const sealing = value.finalizeTerminal(
      JSON.stringify({ reply_md: '稳定候选。', relied_on_tool_use_ids: [] }),
    );
    await entered;
    const late = await pre(value, 'mcp__tavily__tavily_search', 'late_1', {
      query: '后续搜索',
    });
    releaseValidation();
    await sealing;

    const result = await sealing;
    expect(late).toEqual({ continue: true });
    expect(result.accepted).toBe(false);
    expect(result.replyText).not.toBe('稳定候选。');
  });

  it('fails closed on malformed or prose-contaminated terminal output', async () => {
    const value = finalizer();
    const candidate = '{"reply_md":"候选","relied_on_tool_use_ids":[]}';
    for (const terminalText of [
      '普通正文，不是 JSON',
      `${candidate} trailing prose`,
      '{"reply_md":"候选","relied_on_tool_use_ids":[],"extra":true}',
      ['冲突前言', '```json', candidate, '```'].join('\n'),
      ['候选', '```json', candidate, '```', '尾随正文'].join('\n'),
      ['```json', candidate, '```', '```json', candidate, '```'].join('\n'),
    ]) {
      const result = await value.finalizeTerminal(terminalText);
      expect(result.accepted).toBe(false);
      expect(result.replyText).not.toContain('候选');
    }
  });

  it('server-composes FULL proposal disclosure that model prose cannot omit', async () => {
    const value = finalizer();
    await pre(value, 'mcp__loom__propose_learning_item_archive', 'proposal_1', {
      learning_item_id: 'item_1',
    });
    value.observeDomainTool({
      tool_use_id: 'proposal_1',
      name: 'propose_learning_item_archive',
      effect: 'propose',
      input: { learning_item_id: 'item_1' },
      output: { status: 'proposed', proposal_id: 'proposal_1' },
      error_reason: null,
      executed: true,
      proposal_effect_contract: {
        owner_gate: 'FULL',
        direct_write: false,
        rollback: 'dismiss_before_accept',
      },
    });
    await pre(value, 'mcp__loom__propose_learning_item_archive', 'proposal_failed', {
      learning_item_id: 'item_2',
    });
    value.observeDomainTool({
      tool_use_id: 'proposal_failed',
      name: 'propose_learning_item_archive',
      effect: 'propose',
      input: { learning_item_id: 'item_2' },
      output: { status: 'failed' },
      error_reason: 'write conflict',
      executed: true,
      proposal_effect_contract: {
        owner_gate: 'FULL',
        direct_write: false,
        rollback: 'dismiss_before_accept',
      },
    });
    await pre(value, 'mcp__loom__author_question', 'proposal_retained', {
      prompt_md: '求定义域。',
    });
    value.observeDomainTool({
      tool_use_id: 'proposal_retained',
      name: 'author_question',
      effect: 'propose',
      input: { prompt_md: '求定义域。' },
      output: { status: 'proposed', proposal_id: 'proposal_question_1' },
      error_reason: null,
      executed: true,
      proposal_effect_contract: {
        owner_gate: 'FULL',
        direct_write: false,
        rollback: 'dismiss_before_accept',
        retained_draft: {
          kind: 'question',
          written_before_accept: true,
          reversible: false,
          retained_after_dismiss: true,
        },
      },
    });
    const result = await value.finalizeTerminal(
      JSON.stringify({
        reply_md: '已直接归档，LIGHT 即可，无需 owner 通过 FULL gate 接受。',
        relied_on_tool_use_ids: [],
      }),
    );
    expect(result.replyText).toContain('owner gate: FULL');
    expect(result.replyText).toContain('direct target write: false');
    expect(result.replyText).toContain('尚未直接写入');
    expect(result.replyText).not.toContain('已直接归档');
    expect(result.replyText).not.toContain('LIGHT');
    expect(result.replyText).toContain('仍需 owner 通过 FULL gate 接受 proposal');
    expect(result.replyText).toContain('未产生可供 owner 接受的 proposal');
    expect(result.replyText).toContain('retained draft=question');
    expect(result.receipt.proposal_disclosure).toBe('server_composed');
  });

  it('applies deterministic correction and blocks unverified learning content before seal', async () => {
    const validate = vi
      .fn<Parameters<typeof createCopilotReplyFinalizer>[0]['validateLearningContent']>()
      .mockResolvedValueOnce({ replyText: '这份学习内容未完成独立校验，暂不展示。', passed: false })
      .mockImplementation(async (text) => ({ replyText: text, passed: true }));
    const value = createCopilotReplyFinalizer({
      rootTaskRunId: 'root_run_1',
      correctionContract: {
        ...correctionContract,
        target_prior_turn_id: 'turn_1',
        available_prior_turn_ids: ['turn_1'],
      },
      userContextText: '更正上一轮。',
      validateLearningContent: validate,
    });
    const result = await value.finalizeTerminal(
      JSON.stringify({
        reply_md: '缺少更正尾标，并给出练习题。',
        relied_on_tool_use_ids: [],
      }),
    );
    expect(result.replyText).toContain('prior_turn_id');
    expect(result.receipt.correction).toBe('clarify');
    expect(result.receipt.learning_content).toBe('blocked');
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('drops a read-bearing presentation side channel', async () => {
    const value = finalizer();
    await pre(value, 'mcp__loom__query_knowledge', 'read_1', { query: '函数' });
    value.observeDomainTool({
      tool_use_id: 'read_1',
      name: 'query_knowledge',
      effect: 'read',
      input: { query: '函数' },
      output: { nodes: [{ id: 'kc_1', name: '函数' }] },
      error_reason: null,
      executed: true,
    });
    const result = await value.finalizeTerminal(
      JSON.stringify({
        reply_md:
          '已核对。\n<!--primary_view:{"source":"ephemeral_html","ref":"<p>未校验题面</p>"}-->',
        relied_on_tool_use_ids: ['read_1'],
      }),
    );
    expect(result.preparedReply).toEqual({ text: '已核对。' });
    expect(result.receipt.primary_view).toBe('dropped');
  });

  it('bounds the realistic A01/A03 trace and changes its digest when a source result changes', async () => {
    async function sealWithTrace(mutateFirst: boolean) {
      const value = finalizer();
      for (const [index, observation] of REALISTIC_EVIDENCE_TRACE.entries()) {
        const toolUseId = `real_call_${index}`;
        await pre(value, `mcp__loom__${observation.name}`, toolUseId, observation.input);
        value.observeDomainTool({
          ...observation,
          tool_use_id: toolUseId,
          output:
            mutateFirst && index === 0 ? { ...observation.output, total: 999 } : observation.output,
        });
      }
      const result = await value.finalizeTerminal(
        JSON.stringify({
          reply_md: '已核对 A01 与 A03 的 exact window；跨 subject 后段仍未被该 window 穷尽。',
          relied_on_tool_use_ids: ['real_call_0', 'real_call_1'],
        }),
      );
      return result.receipt;
    }

    const original = await sealWithTrace(false);
    const mutated = await sealWithTrace(true);
    expect(original.trace_call_count).toBe(REALISTIC_EVIDENCE_TRACE.length);
    expect(original.trace_call_count).toBeLessThanOrEqual(60);
    expect(original.trace_sha256).not.toBe(mutated.trace_sha256);
  });
});
