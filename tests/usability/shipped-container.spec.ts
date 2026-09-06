import { type Page, expect, test } from '@playwright/test';
import { installApiFixtures } from './api-fixtures';

// YUK-721 — dual-viewport visual-QA capture of the teaching brief on /today.
// YUK-789 — the path was a hard-coded macOS scratchpad (`/private/tmp/claude-501/...`), which a
// non-root CI runner cannot create: wiring this spec into CI required a writable default. Set
// USABILITY_SHOT_DIR to send the captures somewhere else locally.
const SHOT_DIR = process.env.USABILITY_SHOT_DIR ?? 'test-results/usability';
const TB_DESKTOP_SHOT = `${SHOT_DIR}/tb-desktop.png`;
const TB_MOBILE_SHOT = `${SHOT_DIR}/tb-mobile.png`;

test('Copilot accepts consecutive messages and restores each run without cancelling on leave', async ({
  page,
}) => {
  await installApiFixtures(page, 'existing-evidence');
  const sessionId = 'persistent-session-42';
  const turns: Array<Record<string, unknown>> = [];
  const cancelled: string[] = [];
  const submitted: Array<{ key: string; text: string }> = [];
  const runs = new Map<
    string,
    { active: boolean; result: Promise<string>; finish: (body: string) => void }
  >();
  const settle = (runId: string, text: string, stopped = false) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`Missing fixture run ${runId}`);
    run.active = false;
    turns.push({
      role: 'ai',
      run_id: runId,
      event_id: `${runId}-reply`,
      session_id: sessionId,
      text,
      at: '2026-09-07T08:01:00.000Z',
    });
    const frames = [
      { event_id: 1, event_type: 'copilot_run.reply', payload: { reply_md: text } },
      {
        event_id: 2,
        event_type: stopped ? 'copilot_run.failed' : 'copilot_run.done',
        payload: stopped ? { reason: 'cancelled' } : { task_run_id: `${runId}-task` },
      },
    ];
    run.finish(
      frames.map((frame) => `event: job_event\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    );
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/copilot/sessions')
      return route.fulfill({
        json: {
          sessions: [
            {
              id: sessionId,
              status: 'active',
              title: '连续消息恢复验收',
              created_at: '2026-09-07T08:00:00.000Z',
              updated_at: '2026-09-07T08:00:00.000Z',
            },
          ],
        },
      });
    if (path === '/api/copilot/turns')
      return route.fulfill({
        json: {
          session_id: sessionId,
          turns,
          active_runs: [...runs.entries()]
            .filter(([, run]) => run.active)
            .map(([runId], index) => ({
              run_id: runId,
              session_id: sessionId,
              status: index === 0 ? 'running' : 'queued',
              events_url: `/api/jobs/copilot_run/${runId}/events`,
            })),
        },
      });
    if (path === '/api/copilot/chat') {
      const body = route.request().postDataJSON();
      expect(body.session_id).toBe(sessionId);
      const key = route.request().headers()['idempotency-key'];
      expect(key).toBeTruthy();
      submitted.push({ key, text: body.user_message });
      const runId = `persistent-run-${submitted.length}`;
      let finish!: (body: string) => void;
      const result = new Promise<string>((resolve) => {
        finish = resolve;
      });
      runs.set(runId, { active: true, result, finish });
      turns.push({
        role: 'user',
        event_id: runId,
        text: body.user_message,
        at: '2026-09-07T08:00:00.000Z',
      });
      return route.fulfill({
        status: 202,
        headers: { Location: `/api/jobs/copilot_run/${runId}/events` },
        json: { run_id: runId, session_id: sessionId },
      });
    }
    const cancel = path.match(/^\/api\/copilot\/runs\/(persistent-run-\d+)\/cancel$/);
    if (cancel) {
      cancelled.push(cancel[1]);
      settle(cancel[1], '这次请求已停止。', true);
      return route.fulfill({
        json: { ok: true, run_id: cancel[1], status: 'cancelled' },
      });
    }
    const subscription = path.match(/^\/api\/jobs\/copilot_run\/(persistent-run-\d+)\/events$/);
    if (subscription) {
      const run = runs.get(subscription[1]);
      if (!run) throw new Error('Subscription without acceptance');
      const body = await run.result;
      // Refresh/close can abort the original subscription while the fixture
      // keeps the server-owned run alive for the next browser connection.
      return route.fulfill({ contentType: 'text/event-stream', body }).catch(() => undefined);
    }
    return route.fallback();
  });
  const open = () =>
    page.getByRole('banner').getByRole('button', { name: 'Copilot', exact: true }).click();
  const send = async (text: string) => {
    await page.getByLabel('问 Loom 任何事', { exact: true }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
  };
  const stop = (id: number) =>
    page.getByRole('button', { name: `停止这次运行 persistent-run-${id}`, exact: true });
  await page.goto('/today');
  await open();
  await send('先核对定义域，保留未知条件。');
  await expect(stop(1)).toBeVisible();
  await send('再比较零值与缺失值，先不要提交更改。');
  await expect(stop(2)).toBeVisible();
  await stop(2).click();
  await expect(stop(2)).toHaveCount(0);
  await expect(stop(1)).toBeVisible();
  expect(cancelled).toEqual(['persistent-run-2']);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('问 Loom 任何事', { exact: true })).not.toBeVisible();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await open();
  await expect(stop(1)).toBeVisible();
  expect(cancelled).toEqual(['persistent-run-2']);
  await send('最后总结有向关系，不把未批准提案当作事实。');
  await expect(stop(3)).toBeVisible();
  settle('persistent-run-1', '定义域已核对，未知条件仍保留。');
  await expect(page.getByText('定义域已核对，未知条件仍保留。', { exact: true })).toHaveCount(1);
  await expect(stop(1)).toHaveCount(0);
  await expect(stop(3)).toBeVisible();
  settle('persistent-run-3', '有向关系已总结，提案仍为未批准。');
  await expect(stop(3)).toHaveCount(0);
  await page.reload();
  await open();
  for (const { text } of submitted)
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  await expect(page.getByText('定义域已核对，未知条件仍保留。', { exact: true })).toHaveCount(1);
  await expect(page.getByText('有向关系已总结，提案仍为未批准。', { exact: true })).toHaveCount(1);
  expect(submitted).toHaveLength(3);
  expect(new Set(submitted.map(({ key }) => key)).size).toBe(3);
  expect(cancelled).toEqual(['persistent-run-2']);
});

test('Copilot recovers ambiguous acceptance after reload with the original key and body', async ({
  page,
}) => {
  await installApiFixtures(page, 'existing-evidence');
  const requests: Array<{ key: string; body: string | null }> = [];
  const turns: Array<Record<string, unknown>> = [];
  const answer = '零是已观察值，null 仍表示未知；更正尚未获准。';
  const question = '区分零与未知，并保留更正的批准状态。';
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/copilot/sessions')
      return route.fulfill({
        json: {
          sessions: [
            {
              id: 'ambiguous-session',
              status: 'active',
              title: '受理恢复',
              created_at: '2026-09-07T08:00:00.000Z',
              updated_at: '2026-09-07T08:00:00.000Z',
            },
          ],
        },
      });
    if (path === '/api/copilot/turns')
      return route.fulfill({
        json: { session_id: 'ambiguous-session', turns, active_runs: [] },
      });
    if (path === '/api/copilot/chat') {
      requests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postData(),
      });
      if (requests.length === 1) {
        turns.push(
          { role: 'user', event_id: 'ambiguous-run', text: question, at: '2026-09-07T08:00:00Z' },
          {
            role: 'ai',
            event_id: 'ambiguous-reply',
            run_id: 'ambiguous-run',
            session_id: 'ambiguous-session',
            text: answer,
            at: '2026-09-07T08:00:02Z',
          },
        );
        return route.fulfill({
          status: 503,
          json: { error: 'copilot_enqueue_ambiguous', message: '受理响应未能确认。' },
        });
      }
      expect(requests[requests.length - 1]).toEqual(requests[0]);
      return route.fulfill({
        status: 202,
        headers: { Location: '/api/jobs/copilot_run/ambiguous-run/events' },
        json: { run_id: 'ambiguous-run', session_id: 'ambiguous-session' },
      });
    }
    if (path === '/api/jobs/copilot_run/ambiguous-run/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: [
          { event_id: 1, event_type: 'copilot_run.reply', payload: { reply_md: answer } },
          {
            event_id: 2,
            event_type: 'copilot_run.done',
            payload: { task_run_id: 'ambiguous-task' },
          },
        ]
          .map((frame) => `event: job_event\ndata: ${JSON.stringify(frame)}\n\n`)
          .join(''),
      });
    return route.fallback();
  });
  const open = () =>
    page.getByRole('banner').getByRole('button', { name: 'Copilot', exact: true }).click();
  await page.goto('/today');
  await open();
  await page.getByLabel('问 Loom 任何事', { exact: true }).fill(question);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('copilot-pending-recovery')).toBeVisible();
  await page.reload();
  await open();
  await page
    .getByTestId('copilot-pending-recovery')
    .getByRole('button', { name: '恢复', exact: true })
    .click();
  await expect(page.getByTestId('copilot-pending-recovery')).toHaveCount(0);
  await expect(page.getByText(question, { exact: true })).toHaveCount(1);
  await expect(page.getByText(answer, { exact: true })).toHaveCount(1);
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[1]).toEqual(requests[0]);
});

for (const transport of ['persistent'] as const) {
  for (const source of ['none', 'tool_result', 'artifact', 'ephemeral_html'] as const) {
    test(`Copilot ${transport} primary view ${source} survives live delivery and replay`, async ({
      page,
    }) => {
      await installApiFixtures(page, 'existing-evidence');
      const primaryView =
        source === 'none'
          ? undefined
          : source === 'ephemeral_html'
            ? { source, ref: '<section><h2>本轮资料目录</h2><p>原文、注释、背景</p></section>' }
            : {
                source,
                ref: {
                  kind: source === 'artifact' ? 'note' : 'query_knowledge',
                  id: 'presented-42',
                },
              };
      const content = '已整理本轮资料。';
      const turns: Array<Record<string, unknown>> = [];
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/copilot/sessions')
          return route.fulfill({
            json: {
              sessions: [
                {
                  id: 'session-42',
                  status: 'active',
                  title: '展示验收',
                  created_at: '2026-09-06T06:00:00Z',
                  updated_at: '2026-09-06T06:00:00Z',
                },
              ],
            },
          });
        if (path === '/api/copilot/turns')
          return route.fulfill({ json: { session_id: 'session-42', turns, active_runs: [] } });
        if (path === '/api/copilot/chat') {
          expect(route.request().headers()['idempotency-key']).toBeTruthy();
          turns.push({
            role: 'user',
            text: '展示本轮资料',
            event_id: 'view-run-42',
            at: '2026-09-06T06:00:00Z',
          });
          turns.push({
            role: 'ai',
            run_id: 'view-run-42',
            text: content,
            event_id: 'view-reply-42',
            at: '2026-09-06T06:00:00Z',
            ...(primaryView ? { primary_view: primaryView } : {}),
          });
          return route.fulfill({
            status: 202,
            headers: { Location: '/api/jobs/copilot_run/view-run-42/events' },
            json: { run_id: 'view-run-42', session_id: 'session-42' },
          });
        }
        if (path === '/api/jobs/copilot_run/view-run-42/events') {
          const frames = [
            {
              event_id: 1,
              event_type: 'copilot_run.reply',
              payload: { reply_md: content, ...(primaryView ? { primary_view: primaryView } : {}) },
            },
            {
              event_id: 2,
              event_type: 'copilot_run.done',
              payload: { task_run_id: 'view-task-42' },
            },
          ];
          return route.fulfill({
            contentType: 'text/event-stream',
            body: frames
              .map((frame) => `event: job_event\ndata: ${JSON.stringify(frame)}\n\n`)
              .join(''),
          });
        }
        return route.fallback();
      });
      const assertPrimaryView = async () => {
        await expect(page.getByText(content, { exact: true })).toHaveCount(1);
        if (source === 'none')
          await expect(page.locator('[data-testid^="copilot-hero-"]')).toHaveCount(0);
        if (source === 'tool_result')
          await expect(page.getByTestId('copilot-hero-tool-result')).toHaveText('query_knowledge');
        if (source === 'artifact')
          await expect(page.getByTestId('copilot-hero-artifact')).toHaveRole('button');
        if (source === 'ephemeral_html')
          await expect(
            page
              .getByTestId('copilot-hero-ephemeral')
              .frameLocator('iframe')
              .getByText('本轮资料目录'),
          ).toBeVisible();
      };
      await page.goto('/today');
      await page.getByRole('banner').getByRole('button', { name: 'Copilot', exact: true }).click();
      await page.getByLabel('问 Loom 任何事', { exact: true }).fill('展示本轮资料');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await assertPrimaryView();
      await page.reload();
      await page.getByRole('banner').getByRole('button', { name: 'Copilot', exact: true }).click();
      await assertPrimaryView();
    });
  }
}

async function expectNoInternalCopy(page: Page, route: string): Promise<void> {
  const copy = await page.locator('body').innerText();
  expect(
    copy,
    `route=${route} learner surface exposed migration/disconnected-action copy; actual=${JSON.stringify(copy.slice(0, 240))}`,
  ).not.toMatch(/\bM[45]\b|暂未接线|尚未接线|暂未接通|尚未接通|(?:假|伪)成功/);
}

for (const transport of ['persistent'] as const) {
  test(`Copilot ${transport} explicit completion survives the shipped drawer and replay`, async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'existing-evidence');
    const context = { skill: 'quiz', ref: { kind: 'knowledge', id: 'kc-domain-boundary-42' } };
    const content = '已核对定义域、增根与边界条件，练习已经完成。';
    const turns: Array<Record<string, unknown>> = [
      {
        role: 'ai',
        text: '上一次练习已经完成。',
        event_id: 'prior-quiz',
        at: '2026-09-06T06:00:00Z',
        skill_context: context,
        skill_turn: { kind: 'end' },
      },
    ];
    const posts: Array<Record<string, unknown>> = [];
    const terminal = { reply: content, skill_context: context, skill_turn: { kind: 'end' } };
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/copilot/sessions')
        return route.fulfill({
          json: {
            sessions: [
              {
                id: 'session-42',
                status: 'active',
                title: '边界条件复盘',
                created_at: '2026-09-06T06:00:00Z',
                updated_at: '2026-09-06T06:00:00Z',
              },
            ],
          },
        });
      if (path === '/api/copilot/turns')
        return route.fulfill({ json: { session_id: 'session-42', turns, active_runs: [] } });
      if (path === '/api/today/copilot-summary')
        return route.fulfill({
          json: {
            daily_focus: '定义域与边界条件',
            plan_adjustments_count: 0,
            review_due_count: 2,
            brief_global_md: null,
            dreaming_preview: [],
            pending_proposals_total: 0,
          },
        });
      if (path === '/api/copilot/chat') {
        expect(route.request().headers()['idempotency-key']).toBeTruthy();
        posts.push(route.request().postDataJSON());
        const runId = `quiz-42-${posts.length}`;
        const first = posts.length === 1;
        turns.push({
          role: 'user',
          text: posts.at(-1)?.user_message,
          event_id: runId,
          at: '2026-09-06T06:00:00Z',
        });
        turns.push({
          role: 'ai',
          text: first ? content : '收到后续问题。',
          run_id: runId,
          event_id: `reply-${runId}`,
          at: '2026-09-06T06:00:01Z',
          ...(first ? { skill_context: context, skill_turn: { kind: 'end' } } : {}),
        });
        return route.fulfill({
          status: 202,
          headers: { Location: `/api/jobs/copilot_run/${runId}/events` },
          json: { run_id: runId, session_id: 'session-42' },
        });
      }
      const match = path.match(/^\/api\/jobs\/copilot_run\/quiz-42-(\d+)\/events$/);
      if (match) {
        const first = Number(match[1]) === 1;
        const frames = [
          { event_id: 1, event_type: 'copilot_run.delta', payload: { text: '正在核对草稿' } },
          {
            event_id: 2,
            event_type: 'copilot_run.reply',
            payload: { reply_md: first ? content : '收到后续问题。' },
          },
          {
            event_id: 3,
            event_type: 'copilot_run.done',
            payload: first ? terminal : { task_run_id: `task-quiz-${match[1]}` },
          },
        ];
        return route.fulfill({
          contentType: 'text/event-stream',
          body: frames
            .map((frame) => `event: job_event\ndata: ${JSON.stringify(frame)}\n\n`)
            .join(''),
        });
      }
      return route.fallback();
    });
    await page.goto('/today');
    await page.getByRole('banner').getByRole('button', { name: 'Copilot', exact: true }).click();
    const quiz = page.getByTestId('copilot-quiz-chip');
    await expect(quiz).toContainText('当前知识点');
    await quiz.click();
    await expect(page.getByText(content, { exact: true })).toHaveCount(1);
    await expect(page.getByText('正在核对草稿', { exact: true })).toHaveCount(0);
    await page.getByLabel('问 Loom 任何事', { exact: true }).fill('继续核对反例');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[0].skill_context).toEqual(context);
    expect(posts[1].skill_context).toBeUndefined();
    await expect(page.getByText('收到后续问题。', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('banner').getByRole('button', { name: 'Copilot', exact: true }).click();
    await expect(page.getByText(content, { exact: true })).toHaveCount(1);
    await page.getByLabel('问 Loom 任何事', { exact: true }).fill('刷新后继续讨论');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2].skill_context).toBeUndefined();
    expect(fixture.unexpectedRequests).toEqual([]);
  });
}

test.describe('shipped-container usability regression', () => {
  test('route=/today keeps existing evidence out of cold start without an active goal', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'existing-evidence');

    await test.step('route=/today state=no-goal+questions+due renders working dashboard', async () => {
      await page.goto('/today');
      await expect(page.getByText('2 个学习项到期')).toBeVisible();
      await expect(page.getByRole('heading', { name: '先告诉我你想学什么' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /知识节点 3/ })).toBeVisible();
      await expectNoInternalCopy(page, '/today');
    });

    expect(fixture.unexpectedRequests, 'route=/today unexpected API fixtures').toEqual([]);
  });

  test('route=/today renders the true empty-database journey', async ({ page }) => {
    const fixture = await installApiFixtures(page, 'empty-database');

    await test.step('route=/today state=all-evidence-empty shows onboarding CTA', async () => {
      await page.goto('/today');
      await expect(page.getByRole('heading', { name: '先告诉我你想学什么' })).toBeVisible();
      await expect(page.getByRole('button', { name: '开始设定 · 约 2 分钟' })).toBeVisible();
      await expectNoInternalCopy(page, '/today');
    });

    expect(fixture.unexpectedRequests, 'route=/today empty-state unexpected API fixtures').toEqual(
      [],
    );
  });

  test('route=/today returns to a usable token gate after a 401', async ({ page }) => {
    const fixture = await installApiFixtures(page, 'unauthorized');

    await test.step('route=/today status=401 clears auth and exposes retryable form', async () => {
      await page.goto('/today');
      await expect(page.getByLabel('访问令牌')).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('访问令牌无效，请重新输入。');
      await expect(page.getByRole('button', { name: '进入 Loom' })).toBeDisabled();
      await expect
        .poll(() => page.evaluate(() => window.localStorage.getItem('loom_internal_token')))
        .toBeNull();
    });

    expect(fixture.unexpectedRequests, 'route=/today 401 unexpected API fixtures').toEqual([]);
  });

  test('route=/practice keeps the old state on mutation failure and retries in place', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'practice-mutation-failure');

    await test.step('route=/practice control="跳过" status=503 stays pending', async () => {
      await page.goto('/practice');
      await expect(page.getByRole('heading', { name: '练习' })).toBeVisible();
      await page.getByRole('button', { name: '跳过 · 流尾可回头' }).click();
      await expect(page.getByRole('alert')).toContainText(
        '跳过练习失败：fixture mutation rejected',
      );
      await expect(page.getByRole('button', { name: '开始作答' })).toBeVisible();
      await expect(page.getByRole('button', { name: '捡回来' })).toHaveCount(0);
    });

    await test.step('route=/practice control="重试" status=200 commits skipped state', async () => {
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByRole('button', { name: '捡回来' })).toBeVisible();
      expect(fixture.mutationAttempts(), 'route=/practice PATCH attempt count').toBe(2);
      await expectNoInternalCopy(page, '/practice');
    });

    expect(fixture.unexpectedRequests, 'route=/practice unexpected API fixtures').toEqual([]);
  });

  test('route=/today mobile drawer is modal, traps focus, and restores its trigger', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await installApiFixtures(page, 'existing-evidence');

    await test.step('route=/today viewport=390 control="打开导航" exposes modal semantics', async () => {
      await page.goto('/today');
      const trigger = page.getByRole('button', { name: '打开导航' });
      await trigger.click();
      const drawer = page.getByRole('dialog', { name: '主导航' });
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(drawer.getByRole('navigation', { name: '侧栏导航' })).toBeVisible();
      expect(
        await page.evaluate(() =>
          document.querySelector('[role="dialog"]')?.contains(document.activeElement),
        ),
        'route=/today drawer should contain actual focus',
      ).toBe(true);

      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        await page.evaluate(() => document.documentElement.clientWidth),
      );
    });

    expect(fixture.unexpectedRequests, 'route=/today mobile unexpected API fixtures').toEqual([]);
  });

  test('route=/questions progressively loads the full server-side result set', async ({ page }) => {
    const fixture = await installApiFixtures(page, 'questions-pagination');

    await test.step('route=/questions control="继续加载" moves 20/25 to 25/25', async () => {
      await page.goto('/questions');
      await expect(page.getByRole('heading', { name: '题库' })).toBeVisible();
      await expect(page.getByText('已显示 20 / 25 道顶层题目')).toBeVisible();
      await expect(page.getByRole('button', { name: /打开题目：第 1 道回归题/ })).toBeVisible();
      await page.getByRole('button', { name: '继续加载' }).click();
      await expect(page.getByText('已显示 25 / 25 道顶层题目')).toBeVisible();
      await expect(page.getByRole('button', { name: '继续加载' })).toHaveCount(0);
      await expectNoInternalCopy(page, '/questions');
    });

    expect(fixture.unexpectedRequests, 'route=/questions unexpected API fixtures').toEqual([]);
  });

  test('route=/inbox renders A/B/C buckets and real clicks accept then retract projected items', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'inbox-auto-applied');

    await test.step('route=/inbox state=breaker-ok renders all three strength buckets', async () => {
      await page.goto('/inbox');
      await expect(page.getByRole('heading', { name: '收件箱' })).toBeVisible();
      await expect(page.getByText('自动通道正常。')).toBeVisible();
      await expect(page.getByText('自动应用· 1 项')).toBeVisible();
      await expect(page.getByText('待你裁决· 1 项')).toBeVisible();
      await expect(page.getByText('仅作观察· 1 项')).toBeVisible();
      await expect(page.getByText('1 项旁观记录，未执行变更')).toBeVisible();
      await expect(page.getByText('建立学习主线：函数复习计划')).toBeVisible();
      await expect(page.getByRole('term').filter({ hasText: /^学习主线$/ })).toBeVisible();
    });

    await test.step('route=/inbox control="接受" records a real B-bucket decision', async () => {
      const [decisionResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname ===
              '/api/proposals/proposal-learning-plan-1/decisions',
        ),
        page.getByRole('button', { name: '接受', exact: true }).click(),
      ]);
      expect(decisionResponse.status()).toBe(201);
      expect(decisionResponse.headers().location).toBe('/api/events/event-decision-1');
      await expect(page.getByText('已接受', { exact: true })).toBeVisible();
      expect(fixture.proposalDecisions()).toEqual([
        { id: 'proposal-learning-plan-1', decision: 'accept' },
      ]);
    });

    await test.step('route=/inbox control="撤销" transitions the A-bucket completion to reverted', async () => {
      await expect(page.getByText('《岳阳楼记》背诵检查')).toBeVisible();
      await expect(page.getByText(/分钟内可撤销/)).toBeVisible();
      const [retractResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/proposals/proposal-completion-1/decisions',
        ),
        page.getByRole('button', { name: '撤销', exact: true }).click(),
      ]);
      expect(retractResponse.status()).toBe(201);
      expect(retractResponse.headers().location).toBe('/api/events/event-retract-1');
      await expect(page.getByText('已撤销 · 恢复到应用前')).toBeVisible();
      await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
      expect(fixture.proposalDecisions()).toEqual([
        { id: 'proposal-learning-plan-1', decision: 'accept' },
        { id: 'proposal-completion-1', decision: 'retract' },
      ]);
      await expectNoInternalCopy(page, '/inbox');
    });

    expect(fixture.unexpectedRequests, 'route=/inbox unexpected API fixtures').toEqual([]);
  });

  test('route=/inbox renders the tripped breaker as an explicit return to human review', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'inbox-breaker-tripped');

    await page.goto('/inbox');
    await expect(page.getByText('自动应用已暂停。')).toBeVisible();
    await expect(page.getByText(/30\/30/)).toBeVisible();
    await expect(page.getByText(/已退回全人审/)).toBeVisible();
    await expect(page.getByText('自动通道暂停后退回人工裁决。')).toBeVisible();
    await expect(page.getByText('确认学习项已完成', { exact: true })).toBeVisible();
    await expect(page.getByText('标记学习项已完成', { exact: true })).toBeVisible();
    const [decisionResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            '/api/proposals/proposal-breaker-completion-1/decisions',
      ),
      page.getByRole('button', { name: '接受', exact: true }).click(),
    ]);
    expect(decisionResponse.status()).toBe(201);
    expect(decisionResponse.headers().location).toBe('/api/events/event-breaker-decision-1');
    await expect(page.getByText('已接受', { exact: true })).toBeVisible();
    expect(fixture.proposalDecisions()).toEqual([
      { id: 'proposal-breaker-completion-1', decision: 'accept' },
    ]);
    await expectNoInternalCopy(page, '/inbox');
    expect(fixture.unexpectedRequests, 'route=/inbox tripped unexpected API fixtures').toEqual([]);
  });

  test('route=/inbox dismiss returns the production learning-item decision result', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'inbox-auto-applied');
    await page.goto('/inbox');

    const [decisionResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/proposals/proposal-learning-plan-1/decisions',
      ),
      page.getByRole('button', { name: '忽略', exact: true }).click(),
    ]);

    expect(decisionResponse.status()).toBe(201);
    expect(decisionResponse.headers().location).toBe('/api/events/event-decision-1');
    expect(await decisionResponse.json()).toMatchObject({
      decision: 'dismiss',
      result: { kind: 'dismissed', rate_event_id: 'event-decision-1' },
    });
    await expect(page.getByText('已忽略', { exact: true })).toBeVisible();
    expect(fixture.proposalDecisions()).toEqual([
      { id: 'proposal-learning-plan-1', decision: 'dismiss' },
    ]);
    expect(fixture.unexpectedRequests).toEqual([]);
  });

  test('route=/inbox breaker completion dismiss returns the production decision result', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'inbox-breaker-tripped');
    await page.goto('/inbox');

    const [decisionResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            '/api/proposals/proposal-breaker-completion-1/decisions',
      ),
      page.getByRole('button', { name: '忽略', exact: true }).click(),
    ]);

    expect(decisionResponse.status()).toBe(201);
    expect(await decisionResponse.json()).toMatchObject({
      decision: 'dismiss',
      result: { kind: 'dismissed', rate_event_id: 'event-breaker-decision-1' },
    });
    await expect(page.getByText('已忽略', { exact: true })).toBeVisible();
    expect(fixture.proposalDecisions()).toEqual([
      { id: 'proposal-breaker-completion-1', decision: 'dismiss' },
    ]);
    expect(fixture.unexpectedRequests).toEqual([]);
  });

  test('route=/coach real clicks switch views and drill from subject rollup to knowledge trend', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'coach-views');

    await test.step('route=/coach control="展开知识点" transitions efficacy rollup to drilldown', async () => {
      await page.goto('/coach');
      await expect(page.getByRole('heading', { name: 'Coach 复盘中枢' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '成效趋势' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.getByRole('button', { name: /展开知识点/ }).click();
      await expect(page.getByText('数学 · 显著变化知识点')).toBeVisible();
      await expect(page.getByText('二次函数', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '返回科目' })).toBeVisible();
      await expectNoInternalCopy(page, '/coach');
    });

    await test.step('route=/coach control="校准诊断" exposes the calibration tabpanel semantics', async () => {
      await page.getByRole('tab', { name: '校准诊断' }).click();
      const calibration = page.getByRole('tab', { name: '校准诊断' });
      await expect(calibration).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toHaveAttribute(
        'aria-labelledby',
        (await calibration.getAttribute('id')) ?? '',
      );
      await expect(
        page
          .getByRole('region', { name: '有作答记录的知识点表格，可横向滚动' })
          .getByText('二次函数', { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: '有作答记录的知识点表格，可横向滚动' })
          .getByText('数学整体', { exact: true }),
      ).toBeVisible();
      await expectNoInternalCopy(page, '/coach');
    });

    await test.step('route=/coach control="活动量" changes the selected tab and report state', async () => {
      await page.getByRole('tab', { name: '活动量' }).click();
      await expect(page.getByRole('tab', { name: '活动量' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const reviewCount = page.locator('.coach-kpi').filter({ hasText: '复习次数' });
      await expect(reviewCount.getByText('复习次数')).toBeVisible();
      await expect(reviewCount.getByText('5', { exact: true })).toBeVisible();
      const dailyChart = page.locator('.stack-chart');
      await expect(dailyChart.getByText('07-12', { exact: true })).toBeVisible();
      await expect(dailyChart.getByText('07-18', { exact: true })).toBeVisible();
      await expectNoInternalCopy(page, '/coach');
    });

    expect(fixture.unexpectedRequests, 'route=/coach unexpected API fixtures').toEqual([]);
  });

  test('route=/coach degraded mastery series honestly falls back to activity proxy', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'coach-degraded');

    await page.goto('/coach');
    await expect(page.getByRole('tab', { name: '成效趋势' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: /展开知识点/ })).toHaveCount(0);
    await expect(page.getByText('整科概览')).toBeVisible();
    await expect(page.getByText('活动 5 次 · 无掌握度轨迹')).toBeVisible();
    await expect(page.getByText('二次函数', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('img', { name: /数学整体/ })).toHaveCount(0);
    await expectNoInternalCopy(page, '/coach');
    expect(fixture.unexpectedRequests, 'route=/coach degraded unexpected API fixtures').toEqual([]);

    const unexpectedStatuses = await page.evaluate(async () =>
      Promise.all([
        fetch('/api/proposals').then((response) => response.status),
        fetch('/api/knowledge').then((response) => response.status),
      ]),
    );
    expect(unexpectedStatuses).toEqual([501, 501]);
    expect(fixture.unexpectedRequests).toEqual(['GET /api/proposals', 'GET /api/knowledge']);
  });

  test('route=/today surfaces the prepared teaching brief with a11y landmarks and no overflow', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'teaching-brief');
    const BRIEF_HEADINGS = ['教研团正在跟进的判断', '为什么这么判断', '已经为你备好', '当前结果'];

    await test.step('route=/today viewport=1280 renders one h2 + four h3 blocks, both CTAs keyboard-reachable, no guilt copy', async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/today');

      // One card title (h2) + four block headings (h3) — real navigable hierarchy.
      await expect(page.getByRole('heading', { level: 2, name: '为你而备' })).toBeVisible();
      for (const name of BRIEF_HEADINGS) {
        await expect(page.getByRole('heading', { level: 3, name })).toBeVisible();
      }

      // degraded_kinds red flags absent (empty digest) — never a false alarm on a clean night.
      await expect(page.getByText(/失败\s*\d+\s*次/)).toHaveCount(0);

      // Both CTAs visible and keyboard-reachable in order (accept → dismiss).
      const accept = page.getByRole('button', { name: '就按这个方向验证' });
      const dismiss = page.getByRole('button', { name: '不太像' });
      await expect(accept).toBeVisible();
      await expect(dismiss).toBeVisible();
      await accept.focus();
      await expect(accept).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dismiss).toBeFocused();

      // YUK-789 — mount-time telemetry actually left the browser, with the BODY the
      // server's strict discriminated union accepts. A count-only assertion would stay
      // green on a payload the real endpoint 400s (dead funnel, invisible).
      expect(
        fixture.briefInteractions(),
        'route=/today brief band must POST a well-formed brief_seen on mount',
      ).toEqual([{ type: 'brief_seen', brief_id: 'evt_conjecture_wy1', brief_state: 'finding' }]);

      // Anti-guilt wire lock (contract §8.1): no calibration / recurrence-count / backlog
      // framing inside the brief band…
      const bandCopy = await page.locator('.tb-band-wrap').innerText();
      expect(bandCopy).not.toMatch(
        /\d+%|confidence|置信|把握|predicted|baseline|backlog|待裁决|未读|反复出现|失败\s*\d+\s*次/i,
      );
      // …and none of the raw wire field names / backlog-COUNT patterns anywhere on the
      // page body. (Bare 待裁决 is a legitimate /today section label — "进行中 · 待裁决" —
      // so guard the backlog COUNT shape "N 条待…" here, and leave the full guilt-term
      // regex to the band-scoped check above.)
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/confidence|predicted_p|baseline_p|置信|把握|backlog|\d+\s*条待/i);

      await expectNoInternalCopy(page, '/today');
      await page.screenshot({ path: TB_DESKTOP_SHOT, fullPage: true });
    });

    // YUK-789 — the closed-loop click-through. The previous version only focused the CTA
    // and pressed Tab, so an accept button wired to nothing would still have passed. Click
    // it and assert BOTH halves: the mutation was actually hit, and the band advanced to
    // the probe_ready state the server re-projects (contract §5/§6 forward-only advance).
    await test.step('route=/today control="就按这个方向验证" hits the decision mutation and advances to probe_ready', async () => {
      const [decisionResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().endsWith('/api/proposals/evt_conjecture_wy1/decisions'),
        ),
        page.getByRole('button', { name: '就按这个方向验证' }).click(),
      ]);
      expect(decisionResponse.headers().location).toBe('/api/events/evt_rate_wy1');

      // The probe_ready prepared_action replaces the review_finding CTAs in place.
      const answerCta = page.getByRole('button', { name: '现在就试做这道题' });
      await expect(answerCta).toBeVisible();
      await expect(page.getByRole('button', { name: '就按这个方向验证' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '不太像' })).toHaveCount(0);
      await expect(
        page.getByLabel('当前结果').getByText('这道判别题已经备好，等你作答。'),
      ).toBeVisible();
      // §6 forward-announce: the SAME brief_id advancing finding → probe_ready announces once.
      await expect(page.locator('.tb-live')).toHaveText('这道判别题已经备好，等你作答。');
      // Contract §7 failure affordance stays absent on the success path.
      await expect(page.getByText('操作失败，请重试')).toHaveCount(0);

      expect(
        fixture.briefCalls(),
        'route=/today accept must reach the decisions mutation',
      ).toContain('POST /api/proposals/evt_conjecture_wy1/decisions');
      // The accept also records primary_action_started (the funnel's action half). Assert the
      // exact bodies, not the request count: the same-day brief_seen must stay suppressed
      // (one seen, not two) and the action must carry action_kind='accept_probe' with NO
      // result_event_id — the server union rejects that field outside scoped_practice.
      expect(
        fixture.briefInteractions(),
        'route=/today accept must record exactly one brief_seen + one accept_probe action',
      ).toEqual([
        { type: 'brief_seen', brief_id: 'evt_conjecture_wy1', brief_state: 'finding' },
        {
          type: 'primary_action_started',
          brief_id: 'evt_conjecture_wy1',
          action_kind: 'accept_probe',
        },
      ]);

      await expectNoInternalCopy(page, '/today');
    });

    await test.step('route=/today viewport=390 has no horizontal overflow on the brief band', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/today');

      const band = page.locator('.tb-band-wrap');
      await expect(band).toBeVisible();
      expect(
        await band.evaluate((el) => el.scrollWidth <= el.clientWidth),
        'route=/today band scrollWidth should not exceed clientWidth at 390',
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        await page.evaluate(() => document.documentElement.clientWidth),
      );

      await page.screenshot({ path: TB_MOBILE_SHOT, fullPage: true });
    });

    expect(
      fixture.unexpectedRequests,
      'route=/today teaching-brief unexpected API fixtures',
    ).toEqual([]);
  });
});
