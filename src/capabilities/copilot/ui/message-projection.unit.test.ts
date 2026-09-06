import { describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  projectCopilotReply,
  projectDurableCopilotMessage,
  projectToolEvent,
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
  it('inline, durable and replay agree on authoritative content and product state', () => {
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
    const make = (toolUseId: string) =>
      JSON.stringify({
        toolName: 'mcp__loom__query_knowledge',
        toolUseId,
        input: { ids: ['kc-1', 'kc-2'], nested: { history: ['长文本'.repeat(30)] } },
      });
    let calls = projectToolEvent([], 'tool_use', make('first'));
    calls = projectToolEvent(calls, 'tool_use', make('second'));
    calls = projectToolEvent(calls, 'tool_result', make('second'));
    calls = projectToolEvent(calls, 'tool_result', make('second'));
    calls = projectToolEvent(calls, 'tool_use', make('second'));
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.status)).toEqual(['running', 'done']);
    const settled = projectCopilotReply({ ...base, tool_calls: calls }, reply);
    expect(settled?.tool_calls?.map((call) => call.status)).toEqual(['done', 'done']);
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
