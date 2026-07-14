import { type Page, expect, test } from '@playwright/test';
import { installApiFixtures } from './api-fixtures';

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
});
