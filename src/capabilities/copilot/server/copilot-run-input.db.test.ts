// YUK-575 (A1/MF-B, PR1) — shared Copilot run-input assembler DB test.
//
// Runs in the db vitest config (real Postgres testcontainer): it exercises the
// REAL anchored turn reader against seeded events. Durable pickup must bind its
// history to the dispatch-time session + user_ask event: later asks cannot leak
// into the run merely because the worker picked it up later.
//
// The learner-state resolver is injected (a fixture) so the test isolates the
// history-exclusion + assembly logic; a separate unit test covers the degrade
// paths without a DB.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assembleCopilotRunInput } from '@/capabilities/copilot/server/copilot-run-input';
import type { LearnerStateHeader } from '@/capabilities/copilot/server/learner-state';
import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { Conversation } from '@/server/session';

const writtenEventIds: string[] = [];
const touchedSessionIds: string[] = [];

async function createLiveCopilotSession(now: Date): Promise<string> {
  const { sessionId } = await Conversation.findOrCreateCopilotConversation(db, { now });
  touchedSessionIds.push(sessionId);
  return sessionId;
}

// The reader resolves the single most-recent reusable Copilot session across the
// whole table, so terminate any pre-existing live conversation rows before each test.
beforeEach(async () => {
  const rows = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        inArray(learning_session.status, ['active', 'idle']),
      ),
    );
  for (const r of rows) {
    await db.delete(event).where(eq(event.session_id, r.id));
    await db.delete(learning_session).where(eq(learning_session.id, r.id));
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (writtenEventIds.length > 0) {
    await db.delete(event).where(inArray(event.id, writtenEventIds));
    writtenEventIds.length = 0;
  }
  if (touchedSessionIds.length > 0) {
    for (const id of touchedSessionIds) {
      await db.delete(event).where(eq(event.session_id, id));
    }
    await db.delete(learning_session).where(inArray(learning_session.id, touchedSessionIds));
    touchedSessionIds.length = 0;
  }
});

async function writeAsk(
  text: string,
  sessionId: string,
  at: Date,
  idArg?: string,
): Promise<string> {
  const id = idArg ?? `copilot_user_ask_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: { surface: 'copilot', user_message: text, session_id: sessionId },
    created_at: at,
  });
  return id;
}

async function writeChip(text: string, sessionId: string, at: Date): Promise<string> {
  const id = `copilot_chip_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_chip_trigger',
    subject_kind: 'chip',
    subject_id: id,
    outcome: null,
    payload: {
      surface: 'copilot_user_suggested_mistake_action',
      user_message: text,
      chip_kind: 'compare_boundary_cases',
      session_id: sessionId,
    },
    created_at: at,
  });
  return id;
}

async function writeReply(
  text: string,
  sessionId: string,
  inReplyTo: string,
  at: Date,
): Promise<string> {
  const id = `copilot_reply_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'experimental:copilot_reply',
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: {
      surface: 'copilot',
      session_id: sessionId,
      reply_md: text,
      task_run_id: 'task_x',
      in_reply_to_event_id: inReplyTo,
    },
    caused_by_event_id: inReplyTo,
    task_run_id: 'task_x',
    created_at: at,
  });
  return id;
}

async function writeLegacyParentlessReply(
  text: string,
  sessionId: string,
  at: Date,
): Promise<string> {
  const id = `copilot_reply_legacy_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'experimental:copilot_reply',
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: {
      surface: 'copilot',
      session_id: sessionId,
      reply_md: text,
      task_run_id: 'legacy_task_without_causal_parent',
    },
    task_run_id: 'legacy_task_without_causal_parent',
    created_at: at,
  });
  return id;
}

// Injected learner-state fixture: an empty header keeps the assembled history equal
// to the real turns (no pinned context entry), so the exclusion assertions are clean.
const emptyLearnerState = async (): Promise<LearnerStateHeader> => ({
  header_md: '',
  proposal_feedback: [],
});

function userTexts(history: { role: string; text: string }[]): string[] {
  return history.filter((h) => h.role === 'user').map((h) => h.text);
}

describe('assembleCopilotRunInput — durable causal history anchor', () => {
  it('filters future same-session turns before LIMIT so they cannot evict the real pre-anchor history', async () => {
    const t0 = new Date('2026-08-01T10:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);

    for (let i = 1; i <= 6; i++) {
      const ask = await writeAsk(
        `锚点前第 ${i} 轮：核对含参方程定义域与退化分支`,
        sessionId,
        new Date(t0.getTime() + i * 60_000),
      );
      await writeReply(
        `锚点前第 ${i} 轮结论：已用 ${i + 2} 个边界值排除增根`,
        sessionId,
        ask,
        new Date(t0.getTime() + i * 60_000 + 20_000),
      );
    }
    const anchorId = `copilot_user_ask_${createId()}`;
    await writeAsk(
      '当前后台轮：交叉验证 48 道含参题、六个未教学探针和九道迁移题',
      sessionId,
      new Date(t0.getTime() + 10 * 60_000),
      anchorId,
    );
    // More than the query buffer. A post-anchor LIMIT would otherwise return
    // only these future turns and silently erase the true causal history.
    for (let i = 1; i <= 10; i++) {
      const ask = await writeAsk(
        `锚点后第 ${i} 轮：这不属于已派发后台任务的输入`,
        sessionId,
        new Date(t0.getTime() + (10 + i) * 60_000),
      );
      await writeReply(
        `锚点后第 ${i} 轮回答：也不得泄漏进旧 run`,
        sessionId,
        ask,
        new Date(t0.getTime() + (10 + i) * 60_000 + 20_000),
      );
    }

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '当前后台轮：交叉验证 48 道含参题、六个未教学探针和九道迁移题',
        triggeredBy: 'chat',
        now: new Date(t0.getTime() + 30 * 60_000),
        historyAnchorEventId: anchorId,
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    expect(runInput.conversation_history.map((turn) => turn.text)).toEqual([
      '锚点前第 3 轮：核对含参方程定义域与退化分支',
      '锚点前第 3 轮结论：已用 5 个边界值排除增根',
      '锚点前第 4 轮：核对含参方程定义域与退化分支',
      '锚点前第 4 轮结论：已用 6 个边界值排除增根',
      '锚点前第 5 轮：核对含参方程定义域与退化分支',
      '锚点前第 5 轮结论：已用 7 个边界值排除增根',
      '锚点前第 6 轮：核对含参方程定义域与退化分支',
      '锚点前第 6 轮结论：已用 8 个边界值排除增根',
    ]);
    expect(userTexts(runInput.conversation_history)).not.toContain(
      '当前后台轮：交叉验证 48 道含参题、六个未教学探针和九道迁移题',
    );
    expect(runInput.conversation_history.some((turn) => turn.text.includes('锚点后'))).toBe(false);
    expect(runInput.surface).toBe('copilot');
    expect(runInput.triggered_by).toBe('chat');
    expect(runInput.user_message).toContain('48 道含参题');
    expect(runInput.proposal_feedback).toEqual([]);
  });

  it('keeps a late reply to a pre-anchor root but excludes same-millisecond future roots by dispatch order', async () => {
    const sameMillisecond = new Date('2026-08-01T11:00:00.000Z');
    const sessionId = await createLiveCopilotSession(sameMillisecond);
    const priorAsk = await writeAsk('先验轮：用四个极端参数检查定义域', sessionId, sameMillisecond);
    const anchorId = `copilot_user_ask_${createId()}`;
    await writeAsk('当前后台轮：生成并验证三档迁移梯度', sessionId, sameMillisecond, anchorId);
    const futureAsk = await writeAsk(
      '同毫秒但 dispatch_seq 更晚的未来轮',
      sessionId,
      sameMillisecond,
    );
    await writeReply('未来轮回答不得泄漏', sessionId, futureAsk, sameMillisecond);
    // The reply is written after the anchor, but is causally rooted at the old
    // ask and therefore belongs to the anchor's conversation history.
    await writeReply(
      '迟到的先验回答：四个边界值均确认 x≠2，退化分支单独处理',
      sessionId,
      priorAsk,
      sameMillisecond,
    );

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '当前后台轮：生成并验证三档迁移梯度',
        triggeredBy: 'chat',
        now: new Date('2026-08-01T11:30:00Z'),
        historyAnchorEventId: anchorId,
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    expect(runInput.conversation_history).toEqual([
      { role: 'user', text: '先验轮：用四个极端参数检查定义域' },
      { role: 'ai', text: '迟到的先验回答：四个边界值均确认 x≠2，退化分支单独处理' },
    ]);
  });

  it('keeps complete causal pairs when six queued roots precede replies that all land after the anchor', async () => {
    const t0 = new Date('2026-08-01T11:15:00.000Z');
    const sessionId = await createLiveCopilotSession(t0);
    const queuedRoots: string[] = [];

    // Five earlier runs plus this run's anchor are all dispatched before the
    // single worker drains any reply: the real batchSize:1 typing-ahead shape.
    for (let i = 1; i <= 5; i++) {
      queuedRoots.push(
        await writeAsk(
          `排队根 ${i}：分析第 ${i * 9} 次作答的定义域、退化项与迁移失败`,
          sessionId,
          t0,
        ),
      );
    }
    const anchorId = `copilot_user_ask_${createId()}`;
    await writeAsk(
      '第六个排队根（当前 run）：综合前五轮形成下一步教学动作',
      sessionId,
      t0,
      anchorId,
    );

    // The worker completes earlier runs only after the current anchor already
    // exists. Their own dispatch_seq must not separate replies from roots.
    for (const [index, queuedRoot] of queuedRoots.entries()) {
      const i = index + 1;
      await writeReply(
        `排队回复 ${i}：已交叉核对 ${i * 9} 次作答，并保留两个反例分支`,
        sessionId,
        queuedRoot,
        new Date(t0.getTime() + i * 60_000),
      );
    }

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '第六个排队根（当前 run）：综合前五轮形成下一步教学动作',
        triggeredBy: 'chat',
        now: new Date(t0.getTime() + 10 * 60_000),
        historyAnchorEventId: anchorId,
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    expect(runInput.conversation_history).toEqual([
      { role: 'user', text: '排队根 2：分析第 18 次作答的定义域、退化项与迁移失败' },
      { role: 'ai', text: '排队回复 2：已交叉核对 18 次作答，并保留两个反例分支' },
      { role: 'user', text: '排队根 3：分析第 27 次作答的定义域、退化项与迁移失败' },
      { role: 'ai', text: '排队回复 3：已交叉核对 27 次作答，并保留两个反例分支' },
      { role: 'user', text: '排队根 4：分析第 36 次作答的定义域、退化项与迁移失败' },
      { role: 'ai', text: '排队回复 4：已交叉核对 36 次作答，并保留两个反例分支' },
      { role: 'user', text: '排队根 5：分析第 45 次作答的定义域、退化项与迁移失败' },
      { role: 'ai', text: '排队回复 5：已交叉核对 45 次作答，并保留两个反例分支' },
    ]);
  });

  it('handles chip roots and parentless legacy replies without admitting future or cross-session causality', async () => {
    const t0 = new Date('2026-08-01T11:30:00.000Z');
    const sessionId = await createLiveCopilotSession(t0);
    const chipId = await writeChip('比较 a=0、a=2 与 a→∞ 三个边界，先不要生成新题', sessionId, t0);
    await writeReply(
      '边界比较：a=0 退化为常量式，a=2 触发定义域空洞，a→∞ 保留主导项。',
      sessionId,
      chipId,
      new Date(t0.getTime() + 1_000),
    );
    await writeLegacyParentlessReply(
      '旧版无父链摘要：前 18 次作答中，定义域遗漏出现 7 次。',
      sessionId,
      new Date(t0.getTime() + 2_000),
    );

    const otherSessionStart = new Date(t0.getTime() + 25 * 60 * 60_000);
    const otherSessionId = await createLiveCopilotSession(otherSessionStart);
    expect(otherSessionId).not.toBe(sessionId);
    const otherRoot = await writeAsk(
      '另一个 session 的根，不得借 caused_by 混入',
      otherSessionId,
      otherSessionStart,
    );
    const anchorId = `copilot_user_ask_${createId()}`;
    await writeAsk(
      '当前后台轮：结合 18 次作答生成五层迁移验证',
      sessionId,
      new Date(t0.getTime() + 4_000),
      anchorId,
    );

    // Both rows are inserted after dispatch. Only a reply causally rooted in a
    // pre-anchor root from THIS session could be admitted.
    await writeLegacyParentlessReply(
      '锚点后的无父链 reply 不得靠 legacy 规则混入',
      sessionId,
      new Date(t0.getTime() + 5_000),
    );
    await writeReply(
      '虽然 caused_by 指向旧 root，但那个 root 属于另一个 session。',
      sessionId,
      otherRoot,
      new Date(t0.getTime() + 6_000),
    );
    const futureChip = await writeChip(
      '锚点后的 chip 也不得进入旧 run',
      sessionId,
      new Date(t0.getTime() + 7_000),
    );
    await writeReply(
      '锚点后 chip 的回答同样不得进入旧 run',
      sessionId,
      futureChip,
      new Date(t0.getTime() + 8_000),
    );

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '当前后台轮：结合 18 次作答生成五层迁移验证',
        triggeredBy: 'chat',
        now: new Date(otherSessionStart.getTime() + 60_000),
        historyAnchorEventId: anchorId,
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    expect(runInput.conversation_history).toEqual([
      { role: 'user', text: '比较 a=0、a=2 与 a→∞ 三个边界，先不要生成新题' },
      {
        role: 'ai',
        text: '边界比较：a=0 退化为常量式，a=2 触发定义域空洞，a→∞ 保留主导项。',
      },
      { role: 'ai', text: '旧版无父链摘要：前 18 次作答中，定义域遗漏出现 7 次。' },
    ]);
  });

  it('reads the dispatch session after 25h even when a newer reusable session now exists', async () => {
    const oldStart = new Date('2026-08-01T12:00:00Z');
    const oldSessionId = await createLiveCopilotSession(oldStart);
    const priorAsk = await writeAsk(
      '旧 session 先验：核对 27 次作答与三次延迟复习',
      oldSessionId,
      new Date('2026-08-01T12:01:00Z'),
    );
    await writeReply(
      '旧 session 结论：定义域遗漏在三次延迟复习中均复现',
      oldSessionId,
      priorAsk,
      new Date('2026-08-01T12:01:30Z'),
    );
    const anchorId = `copilot_user_ask_${createId()}`;
    await writeAsk(
      '旧 session 后台轮：继续做六个未教学探针',
      oldSessionId,
      new Date('2026-08-01T12:02:00Z'),
      anchorId,
    );

    const pickupAt = new Date('2026-08-02T14:30:00Z');
    const newSessionId = await createLiveCopilotSession(pickupAt);
    expect(newSessionId).not.toBe(oldSessionId);
    const newAsk = await writeAsk(
      '新 session 内容：与旧后台轮无关',
      newSessionId,
      new Date('2026-08-02T14:31:00Z'),
    );
    await writeReply(
      '新 session 回答：不得被旧 run 读取',
      newSessionId,
      newAsk,
      new Date('2026-08-02T14:31:30Z'),
    );

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId: oldSessionId,
        userMessage: '旧 session 后台轮：继续做六个未教学探针',
        triggeredBy: 'chat',
        now: pickupAt,
        historyAnchorEventId: anchorId,
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    expect(runInput.conversation_history).toEqual([
      { role: 'user', text: '旧 session 先验：核对 27 次作答与三次延迟复习' },
      { role: 'ai', text: '旧 session 结论：定义域遗漏在三次延迟复习中均复现' },
    ]);
  });

  it('fails closed to the pinned header when the anchor belongs to another session', async () => {
    const oldStart = new Date('2026-08-01T15:00:00Z');
    const anchorSessionId = await createLiveCopilotSession(oldStart);
    const anchorId = `copilot_user_ask_${createId()}`;
    await writeAsk('session A 的后台轮', anchorSessionId, oldStart, anchorId);
    const requestedSessionId = await createLiveCopilotSession(new Date('2026-08-02T17:00:00Z'));
    expect(requestedSessionId).not.toBe(anchorSessionId);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId: requestedSessionId,
        userMessage: '错误绑定不得读取 session A',
        triggeredBy: 'chat',
        now: new Date('2026-08-02T17:00:01Z'),
        historyAnchorEventId: anchorId,
      },
      {
        resolveLearnerStateHeaderFn: async () => ({
          header_md: '## 固定学习者状态\n仅保留这个确定性 header。',
          proposal_feedback: [],
        }),
      },
    );

    expect(runInput.conversation_history).toEqual([
      { role: 'context', text: '## 固定学习者状态\n仅保留这个确定性 header。' },
    ]);
    expect(log).toHaveBeenCalledWith(
      '[assembleCopilotRunInput] loadHistory failed; degrading to header-only',
      expect.objectContaining({
        session_id: requestedSessionId,
        history_anchor_event_id: anchorId,
      }),
    );
    log.mockRestore();
  });

  it('alerts and preserves the locked reusable-session fallback for missing legacy anchors', async () => {
    const t0 = new Date('2026-08-01T18:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const priorAsk = await writeAsk(
      '兼容历史：复核 21 次作答中的定义域遗漏与退化项',
      sessionId,
      new Date(t0.getTime() + 1_000),
    );
    await writeReply(
      '兼容历史结论：7 次遗漏集中在参数为零和分母退化两类。',
      sessionId,
      priorAsk,
      new Date(t0.getTime() + 2_000),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      for (const historyAnchorEventId of [`missing_copilot_anchor_${createId()}`, '']) {
        const runInput = await assembleCopilotRunInput(
          db,
          {
            sessionId,
            userMessage: '旧 durable job 缺锚点时沿用已锁兼容谓词',
            triggeredBy: 'chat',
            now: new Date(t0.getTime() + 60_000),
            historyAnchorEventId,
          },
          { resolveLearnerStateHeaderFn: emptyLearnerState },
        );
        expect(runInput.conversation_history).toEqual([
          { role: 'user', text: '兼容历史：复核 21 次作答中的定义域遗漏与退化项' },
          { role: 'ai', text: '兼容历史结论：7 次遗漏集中在参数为零和分母退化两类。' },
        ]);
      }
      expect(log).toHaveBeenCalledTimes(2);
      for (const historyAnchorEventId of [expect.stringContaining('missing_copilot_anchor_'), '']) {
        expect(log).toHaveBeenCalledWith(
          '[assembleCopilotRunInput] history anchor missing; falling back to reusable-session history',
          expect.objectContaining({
            session_id: sessionId,
            history_anchor_event_id: historyAnchorEventId,
          }),
        );
      }
    } finally {
      log.mockRestore();
    }
  });

  it('fails closed for an existing non-user-ask anchor instead of treating it as legacy', async () => {
    const t0 = new Date('2026-08-01T18:30:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const priorAsk = await writeAsk(
      '当前 session 有真实历史，但错误 action 不得猜测读取',
      sessionId,
      new Date(t0.getTime() + 1_000),
    );
    await writeReply(
      '这段内容在完整性错误分支必须被 fail-closed 隐藏。',
      sessionId,
      priorAsk,
      new Date(t0.getTime() + 2_000),
    );
    const invalidAnchor = await writeChip(
      'chip 不是 durable user_ask anchor',
      sessionId,
      new Date(t0.getTime() + 3_000),
    );
    const header = '## 固定学习者状态\n锚点损坏时只保留这份确定性上下文。';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const runInput = await assembleCopilotRunInput(
        db,
        {
          sessionId,
          userMessage: '完整性错误不得回退到 reusable-session reader',
          triggeredBy: 'chat',
          now: new Date(t0.getTime() + 60_000),
          historyAnchorEventId: invalidAnchor,
        },
        {
          resolveLearnerStateHeaderFn: async () => ({
            header_md: header,
            proposal_feedback: [],
          }),
        },
      );
      expect(runInput.conversation_history).toEqual([{ role: 'context', text: header }]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        '[assembleCopilotRunInput] loadHistory failed; degrading to header-only',
        expect.objectContaining({
          session_id: sessionId,
          history_anchor_event_id: invalidAnchor,
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('inline (no history anchor): read-before-write — history has no current ask because it is not yet written', async () => {
    const t0 = new Date('2026-07-07T11:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const priorAsk = await writeAsk('历史问题', sessionId, new Date('2026-07-07T11:01:00Z'));
    await writeReply('历史回答', sessionId, priorAsk, new Date('2026-07-07T11:01:30Z'));

    // Inline calls the assembler BEFORE writing the current ask, so the current ask
    // simply is not in the table yet. Omit historyAnchorEventId.
    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '当前内联问题',
        triggeredBy: 'chat',
        now: new Date('2026-07-07T11:02:00Z'),
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    const users = userTexts(runInput.conversation_history);
    expect(users).toContain('历史问题');
    expect(users).not.toContain('当前内联问题');
  });

  it('ambient + chip_kind ride the run input when present (S4)', async () => {
    const t0 = new Date('2026-07-07T12:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: 'q',
        triggeredBy: 'chip',
        chipKind: 'out_3_variants',
        ambient: { route: '/learn/x', focused_entity: { kind: 'knowledge', id: 'k_1' } },
        now: new Date('2026-07-07T12:00:01Z'),
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );
    expect(runInput.ambient_context).toEqual({
      route: '/learn/x',
      focused_entity: { kind: 'knowledge', id: 'k_1' },
    });
    expect(runInput.chip_kind).toBe('out_3_variants');
    expect(runInput.surface).toBe('copilot_user_suggested_mistake_action');
    expect(runInput.triggered_by).toBe('chip');
  });

  it('omits ambient_context / chip_kind keys when absent (byte-parity spread-when-present)', async () => {
    const t0 = new Date('2026-07-07T13:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const runInput = await assembleCopilotRunInput(
      db,
      { sessionId, userMessage: 'q', triggeredBy: 'chat', now: new Date('2026-07-07T13:00:01Z') },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );
    expect('ambient_context' in runInput).toBe(false);
    expect('chip_kind' in runInput).toBe(false);
  });
});
