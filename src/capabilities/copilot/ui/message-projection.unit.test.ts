import { describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  acceptPendingCopilotRun,
  copilotRunReplyMessageId,
  projectCopilotReply,
  projectCopilotRunUpdate,
  projectDurableCopilotMessage,
  projectPendingCopilotMessagePair,
  reconcileCopilotSnapshotMessages,
  upsertCopilotMessage,
} from './message-projection';
import { type ReplaySkillContext, replayToMessages } from './replay';
import { nextSkillContext } from './skill-lifecycle';
import { createCopilotRunView, foldCopilotRunFrames } from './subtask-events';

const context: ReplaySkillContext = {
  skill: 'quiz',
  ref: { kind: 'knowledge', id: 'kc-电磁感应-42' },
};
const base: ChatMessage = {
  id: 'reply-42',
  role: 'ai',
  text: '临时文字不会覆盖最终答案',
  streaming: true,
};
const reply = {
  reply: '已根据错题与讲义生成练习。\n\n含多步推导、边界条件与单位核对。',
  session_id: 'session-42',
  reply_event_id: 'reply-42',
  checkpoint_event_id: 'ask-42',
  skill_turn: { kind: 'end' as const },
  skill_context: context,
  primary_view: { source: 'artifact' as const, ref: { kind: 'paper', id: 'paper-42' } },
  internal_prompt: 'Never enters a message',
};

describe('Copilot message projection', () => {
  it('durable live projection and replay agree on authoritative content and product state', () => {
    const live = projectCopilotReply(base, reply);
    const view = foldCopilotRunFrames(createCopilotRunView(), [
      {
        event_id: 4,
        event_type: 'copilot_run.done',
        payload: { skill_turn: reply.skill_turn, skill_context: context },
      },
      { event_id: 2, event_type: 'copilot_run.delta', payload: { text: '临时草稿' } },
      {
        event_id: 3,
        event_type: 'copilot_run.reply',
        payload: { ...reply, reply_md: reply.reply },
      },
      { event_id: 3, event_type: 'copilot_run.reply', payload: { reply_md: '重复帧不得覆盖' } },
    ]);
    const durable = projectDurableCopilotMessage(base, view, '等待');
    if (!durable) throw new Error('expected terminal presentation');
    const [replayed] = replayToMessages([
      { ...reply, role: 'ai', event_id: 'reply-42', text: reply.reply, at: '2026-09-06T05:30:00Z' },
    ]);
    const presentation = (message: typeof live) =>
      message && {
        text: message.text,
        session_id: message.session_id,
        reply_event_id: message.reply_event_id,
        checkpoint_event_id: message.checkpoint_event_id,
        skill_turn: message.skill_turn,
        skill_context: message.skill_context,
        primary_view: message.primary_view,
      };
    expect(presentation(durable)).toEqual(presentation(live));
    expect(presentation(replayed)).toEqual(presentation(live));
    expect(JSON.stringify(live)).not.toContain('internal_prompt');
    expect(nextSkillContext(context, durable)).toBeNull();
    expect(upsertCopilotMessage(upsertCopilotMessage([], durable), durable)).toHaveLength(1);
  });
  it.each(['cancelled', 'exhausted', 'ambiguous_execution'])(
    'does not end a mode on durable %s',
    (reason) => {
      const view = foldCopilotRunFrames(createCopilotRunView(), [
        {
          event_id: 1,
          event_type: 'copilot_run.reply',
          payload: { ...reply, reply_md: reply.reply },
        },
        {
          event_id: 2,
          event_type: 'copilot_run.failed',
          payload: { reason, reply_md: '这次未完成。' },
        },
      ]);
      const message = projectDurableCopilotMessage(
        {
          ...base,
          checkpoint_event_id: 'ask-old',
          tool_calls: [
            { toolName: 'query_knowledge', input: { ids: ['kc-42', 'kc-43'] }, status: 'running' },
          ],
        },
        view,
        '失败',
      );
      if (!message) throw new Error('expected failure presentation');
      expect(nextSkillContext(context, message)).toBe(context);
      expect(message.streaming).toBe(false);
      expect(message.tool_calls?.[0].status).toBe('failed');
      if (reason === 'ambiguous_execution') expect(message.checkpoint_event_id).toBeUndefined();
    },
  );
  it('preserves a partial reply but does not turn an error-bearing end into success', () => {
    const message = projectCopilotReply(base, { ...reply, error: '内容被截断' });
    expect(message?.text).toBe(reply.reply);
    expect(message?.skill_turn).toBeUndefined();
    expect(nextSkillContext(context, message ?? {})).toBe(context);
    expect(projectCopilotReply(base, { reply: 42 })).toBeNull();
    expect(projectCopilotReply(base, { reply: ' \n ' })).toBeNull();
  });
  it('preserves legacy unknown mode state and accepts done-only additive metadata', () => {
    expect(nextSkillContext(context, projectCopilotReply(base, { reply: '旧回复' }) ?? {})).toBe(
      context,
    );
    const view = foldCopilotRunFrames(createCopilotRunView(), [
      { event_id: 1, event_type: 'copilot_run.reply', payload: { reply_md: '练习已准备好。' } },
      {
        event_id: 2,
        event_type: 'copilot_run.done',
        payload: { skill_turn: { kind: 'end' }, skill_context: context },
      },
    ]);
    expect(projectDurableCopilotMessage(base, view, '等待')?.skill_turn).toEqual({ kind: 'end' });
  });
  it('does not certify an empty durable completion using its progress placeholder', () => {
    const view = foldCopilotRunFrames(createCopilotRunView(), [
      {
        event_id: 1,
        event_type: 'copilot_run.done',
        payload: { skill_turn: { kind: 'end' }, skill_context: context },
      },
    ]);
    expect(projectDurableCopilotMessage(base, view, '正在处理')).toBeNull();
  });
  it('correlates repeated and out-of-order same-name tool calls by stable identity', () => {
    const view = foldCopilotRunFrames(createCopilotRunView(), [
      {
        event_id: 1,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_started',
          tool_name: 'mcp__loom__query_knowledge',
          tool_use_id: 'first',
          input: { ids: ['kc-1', 'kc-2'], nested: { history: ['长文本'.repeat(30)] } },
        },
      },
      {
        event_id: 2,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_started',
          tool_name: 'mcp__loom__query_knowledge',
          tool_use_id: 'second',
          input: { ids: ['kc-3'] },
        },
      },
      {
        event_id: 3,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_finished',
          tool_name: 'mcp__loom__query_knowledge',
          input: { ids: ['kc-1', 'kc-2'] },
          summary: '第一批知识证据读取完成。',
        },
      },
    ]);
    expect(view.toolCalls).toHaveLength(2);
    expect(view.toolCalls?.map((call) => call.status)).toEqual(['done', 'running']);
    const projected = projectDurableCopilotMessage(base, view, '处理中');
    const settled = projectCopilotReply(projected ?? base, reply);
    expect(settled?.tool_calls?.map((call) => call.status)).toEqual(['done', 'done']);
  });

  it('keeps two optimistic turns distinct and remaps out-of-order 202s by idempotency key', () => {
    let messages = projectPendingCopilotMessagePair([], {
      idempotencyKey: 'key-first',
      sessionId: 'session-42',
      userMessageId: 'optimistic-user-first',
      aiMessageId: 'optimistic-ai-first',
      userMessage: '先核对函数定义域。',
    });
    messages = projectPendingCopilotMessagePair(messages, {
      idempotencyKey: 'key-second',
      sessionId: 'session-42',
      userMessageId: 'optimistic-user-second',
      aiMessageId: 'optimistic-ai-second',
      userMessage: '再生成电磁感应迁移题。',
    });
    messages = acceptPendingCopilotRun(messages, {
      idempotencyKey: 'key-second',
      sessionId: 'session-42',
      runId: 'run-second',
    });
    messages = acceptPendingCopilotRun(messages, {
      idempotencyKey: 'key-first',
      sessionId: 'session-42',
      runId: 'run-first',
    });

    expect(messages.map((message) => message.id)).toEqual([
      'run-first',
      copilotRunReplyMessageId('run-first'),
      'run-second',
      copilotRunReplyMessageId('run-second'),
    ]);
    expect(messages.filter((message) => message.idempotency_key)).toHaveLength(0);
  });

  it('associates a snapshot reply to its run without dropping another optimistic ask', () => {
    const previous = projectPendingCopilotMessagePair(
      [
        {
          id: 'run-first',
          role: 'user',
          text: '第一轮',
          session_id: 'session-42',
          run_id: 'run-first',
        },
        {
          id: copilotRunReplyMessageId('run-first'),
          role: 'ai',
          text: '第一轮处理中',
          session_id: 'session-42',
          run_id: 'run-first',
          streaming: true,
        },
      ],
      {
        idempotencyKey: 'key-second',
        sessionId: 'session-42',
        userMessageId: 'optimistic-user-second',
        aiMessageId: 'optimistic-ai-second',
        userMessage: '第二轮',
      },
    );
    const replayed: ChatMessage[] = [
      { id: 'run-first', role: 'user', text: '第一轮', session_id: 'session-42' },
      {
        id: 'reply-first',
        role: 'ai',
        text: '第一轮已完成。',
        session_id: 'session-42',
        run_id: 'run-first',
      },
    ];

    const reconciled = reconcileCopilotSnapshotMessages(
      previous,
      replayed,
      'session-42',
      new Set(),
    );
    expect(reconciled.map((message) => message.id)).toEqual([
      'run-first',
      'reply-first',
      'optimistic-user-second',
      'optimistic-ai-second',
    ]);
    expect(reconciled.some((message) => message.id === copilotRunReplyMessageId('run-first'))).toBe(
      false,
    );
  });

  it('lets a persisted run reply win when same-key recovery returns its 202 after refresh', () => {
    const idempotencyKey = '8d766019-08e5-4d0d-9df5-a1285c5eaf16';
    const runId = 'copilot_user_ask_already_settled';
    const pending = projectPendingCopilotMessagePair([], {
      idempotencyKey,
      sessionId: 'copilot-session-settled',
      userMessageId: 'optimistic-user-settled',
      aiMessageId: 'optimistic-ai-settled',
      userMessage: '恢复已经完成但 202 丢失的请求。',
      dispatching: false,
    });
    const replayed: ChatMessage[] = [
      {
        id: runId,
        role: 'user',
        text: '恢复已经完成但 202 丢失的请求。',
        session_id: 'copilot-session-settled',
      },
      {
        id: 'copilot_reply_already_settled',
        role: 'ai',
        text: '服务端已经持久完成。',
        session_id: 'copilot-session-settled',
        run_id: runId,
      },
    ];
    const snapshotted = reconcileCopilotSnapshotMessages(
      pending,
      replayed,
      'copilot-session-settled',
      new Set(),
    );
    const accepted = acceptPendingCopilotRun(snapshotted, {
      idempotencyKey,
      sessionId: 'copilot-session-settled',
      runId,
    });
    const projected = projectCopilotRunUpdate(accepted, {
      runId,
      sessionId: 'copilot-session-settled',
      view: createCopilotRunView(),
      fallbackText: '正在等待处理这次请求。',
    });

    expect(projected.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(projected.filter((message) => message.role === 'ai')).toEqual([
      expect.objectContaining({
        id: 'copilot_reply_already_settled',
        text: '服务端已经持久完成。',
        run_id: runId,
      }),
    ]);
  });
  it('rejects draft-only completion and never appends late deltas to an authoritative reply', () => {
    const draft = { event_id: 1, event_type: 'copilot_run.delta', payload: { text: '未验证草稿' } };
    const done = {
      event_id: 4,
      event_type: 'copilot_run.done',
      payload: { skill_turn: { kind: 'end' }, skill_context: context },
    };
    const incomplete = foldCopilotRunFrames(createCopilotRunView(), [draft, done]);
    expect(projectDurableCopilotMessage(base, incomplete, '正在处理')).toBeNull();
    const complete = foldCopilotRunFrames(createCopilotRunView(), [
      draft,
      { event_id: 2, event_type: 'copilot_run.reply', payload: { reply_md: reply.reply } },
      { ...draft, event_id: 3 },
      done,
    ]);
    expect(projectDurableCopilotMessage(base, complete, '正在处理')?.text).toBe(reply.reply);
  });
});
