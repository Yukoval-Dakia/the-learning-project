import { type Page, expect, test } from '@playwright/test';
import { installApiFixtures } from './api-fixtures';

// YUK-721 — dual-viewport visual-QA capture of the teaching brief on /today.
// YUK-789 — the path was a hard-coded macOS scratchpad (`/private/tmp/claude-501/...`), which a
// non-root CI runner cannot create: wiring this spec into CI required a writable default. Set
// USABILITY_SHOT_DIR to send the captures somewhere else locally.
const SHOT_DIR = process.env.USABILITY_SHOT_DIR ?? 'test-results/usability';
const TB_DESKTOP_SHOT = `${SHOT_DIR}/tb-desktop.png`;
const TB_MOBILE_SHOT = `${SHOT_DIR}/tb-mobile.png`;

async function expectNoInternalCopy(page: Page, route: string): Promise<void> {
  const copy = await page.locator('body').innerText();
  expect(
    copy,
    `route=${route} learner surface exposed migration/disconnected-action copy; actual=${JSON.stringify(copy.slice(0, 240))}`,
  ).not.toMatch(/\bM[45]\b|暂未接线|尚未接线|暂未接通|尚未接通|(?:假|伪)成功/);
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

  test('route=/inbox real click retracts an auto-applied item and renders the projected state', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'inbox-auto-applied');

    await test.step('route=/inbox control="撤销" transitions the completion from live to reverted', async () => {
      await page.goto('/inbox');
      await expect(page.getByRole('heading', { name: '收件箱' })).toBeVisible();
      await expect(page.getByText('《岳阳楼记》背诵检查')).toBeVisible();
      await expect(page.getByText(/分钟内可撤销/)).toBeVisible();

      await page.getByRole('button', { name: '撤销', exact: true }).click();

      await expect(page.getByText('已撤销 · 恢复到应用前')).toBeVisible();
      await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
      await expectNoInternalCopy(page, '/inbox');
    });

    expect(fixture.unexpectedRequests, 'route=/inbox unexpected API fixtures').toEqual([]);
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

    await test.step('route=/coach control="活动量" changes the selected tab and report state', async () => {
      await page.getByRole('tab', { name: '活动量' }).click();
      await expect(page.getByRole('tab', { name: '活动量' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const reviewCount = page.locator('.coach-kpi').filter({ hasText: '复习次数' });
      await expect(reviewCount.getByText('复习次数')).toBeVisible();
      await expect(reviewCount.getByText('5', { exact: true })).toBeVisible();
      await expectNoInternalCopy(page, '/coach');
    });

    expect(fixture.unexpectedRequests, 'route=/coach unexpected API fixtures').toEqual([]);
  });

  test('route=/today surfaces the prepared teaching brief with a11y landmarks and no overflow', async ({
    page,
  }) => {
    const fixture = await installApiFixtures(page, 'teaching-brief');
    const BRIEF_HEADINGS = ['教研团在检验什么', '为什么这么判断', '已经为你备好', '当前结果'];

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
      await page.getByRole('button', { name: '就按这个方向验证' }).click();

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
