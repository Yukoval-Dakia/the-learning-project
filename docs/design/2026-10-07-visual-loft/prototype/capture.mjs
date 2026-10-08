// Evidence capture for the YUK-1353 loft: screenshots, interaction recordings, metrics.
// Needs the loft dev server (see vite.config.mjs) and Playwright Chromium.
//   node docs/design/2026-10-07-visual-loft/prototype/capture.mjs shots|states|video|metrics|all
//   node docs/design/2026-10-07-visual-loft/prototype/capture.mjs quick a home light desktop [extra=query]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.LOFT_URL ?? 'http://localhost:5199/';
const OUT = join(import.meta.dirname, '..', 'evidence');
const VARIANTS = ['a', 'b', 'c'];
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const url = (q) => `${BASE}?${new URLSearchParams({ chrome: '0', ...q })}`;

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

function toWebp(png, dest) {
  const tmp = `${dest}.png`;
  writeFileSync(tmp, png);
  execFileSync('cwebp', ['-quiet', '-q', '86', '-m', '6', tmp, '-o', dest]);
  rmSync(tmp);
}

async function shoot(browser, device, q, dest, { full = true, before } = {}) {
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url(q));
  await settle(page);
  if (before) {
    await before(page);
    await settle(page);
  }
  if (full) {
    // Grow the viewport to the document so sticky/fixed bars sit where they would at the end
    // of a scroll, instead of floating over mid-page content as fullPage capture does.
    const h = await page.evaluate(() => Math.min(6000, document.documentElement.scrollHeight));
    await page.setViewportSize({ width: DEVICES[device].viewport.width, height: Math.max(h, DEVICES[device].viewport.height) });
    await settle(page);
  }
  const png = await page.screenshot();
  await ctx.close();
  if (dest.endsWith('.png')) writeFileSync(dest, png);
  else toWebp(png, dest);
  console.log('shot', dest);
}

async function shots(browser) {
  const dir = join(OUT, 'screens');
  mkdirSync(dir, { recursive: true });
  for (const v of VARIANTS)
    for (const screen of ['home', 'work'])
      for (const device of Object.keys(DEVICES))
        for (const theme of ['light', 'dark'])
          for (const full of [false, true])
            await shoot(browser, device, { v, screen, theme }, join(dir, `${v}-${screen}-${device}-${theme}${full ? '-full' : ''}.webp`), { full });
}

async function states(browser) {
  const dir = join(OUT, 'states');
  mkdirSync(dir, { recursive: true });
  for (const v of VARIANTS) {
    for (const state of ['absent', 'empty', 'loading', 'error'])
      await shoot(browser, 'desktop', { v, screen: 'home', theme: 'light', state }, join(dir, `${v}-home-${state}.webp`), { full: false });
    for (const device of Object.keys(DEVICES))
      await shoot(browser, device, { v, screen: 'work', theme: 'light', help: '1' }, join(dir, `${v}-work-help-open-${device}.webp`), {
        full: false,
        before: async (page) => {
          const opener = page.locator('[data-act="help"]').filter({ visible: true });
          if (await opener.count()) await opener.first().click();
          await page.waitForTimeout(300);
          await page.locator('[data-act="hint2"]').filter({ visible: true }).first().click();
        },
      });
    await shoot(browser, 'desktop', { v, screen: 'work', theme: 'light', help: '1' }, join(dir, `${v}-work-explain-streaming-desktop.webp`), {
      full: false,
      before: async (page) => {
        const opener = page.locator('[data-act="help"]').filter({ visible: true });
        if (await opener.count()) await opener.first().click();
        await page.locator('[data-act="explain"]').filter({ visible: true }).first().click();
        await page.waitForTimeout(350);
      },
    });
    await shoot(browser, 'desktop', { v, screen: 'home', theme: 'dark' }, join(dir, `${v}-palette-dark.webp`), {
      full: false,
      before: async (page) => {
        await page.keyboard.press('Meta+k');
        await page.keyboard.type('提示');
      },
    });
  }
}

// One scripted pass through both screens. Every step uses data-act hooks shared by all variants.
async function flow(page, device, mark = async () => {}) {
  const tap = async (sel) => {
    const loc = page.locator(sel).filter({ visible: true }).first();
    await loc.scrollIntoViewIfNeeded();
    await mark(sel);
    if (device === 'mobile') await loc.tap();
    else await loc.click();
    await page.waitForTimeout(650);
  };
  await page.waitForTimeout(900);
  if (device === 'desktop') {
    await page.locator('[data-act="continue"]').first().hover();
    await page.waitForTimeout(400);
  }
  await tap('[data-act="why"]');
  await page.waitForTimeout(500);
  await tap('[data-act="snooze"]');
  await page.waitForTimeout(500);
  await tap('.toast-action');
  await page.waitForTimeout(400);
  await tap('[data-act="continue"]');
  await page.waitForTimeout(600);
  const input = page.locator('[data-draft-input]').filter({ visible: true }).first();
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await page.keyboard.type('因为 $t\\ge 1$，等号取不到，要看单调性', { delay: 35 });
  await mark('add-step');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  if (await page.locator('[data-act="help"]').filter({ visible: true }).count()) await tap('[data-act="help"]');
  await tap('[data-act="hint2"]');
  await tap('[data-act="explain"]');
  await page.waitForTimeout(2600);
  if (await page.locator('[data-act="help-close"]').filter({ visible: true }).count()) await tap('[data-act="help-close"]');
  await page.waitForTimeout(500);
  await page.locator('.step-text').filter({ hasText: '单调性' }).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  if (device === 'desktop') {
    await mark('palette');
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(400);
    await page.keyboard.type('回来', { delay: 60 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
  } else {
    await tap('[data-act="back"]');
  }
  await page.waitForTimeout(1200);
}

async function video(browser) {
  const dir = join(OUT, 'video');
  mkdirSync(dir, { recursive: true });
  for (const v of VARIANTS)
    for (const device of Object.keys(DEVICES)) {
      const raw = join(dir, `raw-${v}-${device}`);
      const size = device === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 };
      const ctx = await browser.newContext({
        ...DEVICES[device],
        ...(device === 'desktop' ? { viewport: size } : {}),
        recordVideo: { dir: raw, size },
      });
      const page = await ctx.newPage();
      await page.goto(url({ v, screen: 'home', theme: 'light' }));
      await settle(page);
      await flow(page, device);
      await ctx.close();
      const webm = readdirSync(raw).find((f) => f.endsWith('.webm'));
      const mp4 = join(dir, `${v}-${device}-flow.mp4`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(raw, webm), '-c:v', 'libx264', '-crf', '30', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
      rmSync(raw, { recursive: true });
      console.log('video', mp4);
    }
}

const OBSERVE = () => {
  const m = { cls: 0, shifts: [], events: [], windows: [] };
  window.__m = m;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (!e.hadRecentInput) {
        m.cls += e.value;
        m.shifts.push({ v: e.value, t: Math.round(e.startTime) });
      }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.interactionId) m.events.push({ name: e.name, id: e.interactionId, d: e.duration, t: Math.round(e.startTime) });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  // Frame intervals for 600ms after each marked interaction.
  window.__mark = (label) => {
    const w = { label, gaps: [] };
    m.windows.push(w);
    const start = performance.now();
    let last = start;
    const tick = (t) => {
      w.gaps.push(t - last);
      last = t;
      if (t - start < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
};

async function metrics(browser) {
  const runs = Number(process.env.LOFT_RUNS ?? 3);
  const results = [];
  for (let run = 1; run <= runs; run++)
  for (const throttle of [1, 4])
    for (const v of VARIANTS)
      for (const device of Object.keys(DEVICES)) {
        const ctx = await browser.newContext(DEVICES[device]);
        await ctx.addInitScript(OBSERVE);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        await page.goto(url({ v, screen: 'home', theme: 'light' }));
        await settle(page);
        // Idle baseline: frame gaps with no interaction, to separate headless timing noise from jank.
        await page.evaluate(() => window.__mark('idle-baseline'));
        await page.waitForTimeout(800);
        await flow(page, device, (label) => page.evaluate((l) => window.__mark(l), label));
        const m = await page.evaluate(() => window.__m);
        await ctx.close();
        const byId = new Map();
        for (const e of m.events) byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.d));
        const durations = [...byId.values()].sort((x, y) => x - y);
        const windows = m.windows.map((w) => {
          const gaps = w.gaps.slice(1);
          const long = gaps.filter((g) => g > 1000 / 60 + 4).length;
          return {
            label: w.label,
            frames: gaps.length,
            maxGapMs: Math.round(Math.max(0, ...gaps)),
            over20msShare: gaps.length ? Number((long / gaps.length).toFixed(3)) : null,
          };
        });
        const row = {
          run,
          variant: v,
          device,
          cpuThrottle: throttle,
          cls: Number(m.cls.toFixed(4)),
          interactions: durations.length,
          inpProxyMs: durations.length ? durations[durations.length - 1] : 0,
          medianInteractionMs: durations.length ? durations[Math.floor(durations.length / 2)] : 0,
          worstFrameGapMs: Math.max(0, ...windows.map((w) => w.maxGapMs)),
          windows,
        };
        results.push(row);
        console.log(v, device, `cpu×${throttle}`, `cls=${row.cls}`, `inp≈${row.inpProxyMs}ms`, `worstFrame=${row.worstFrameGapMs}ms`);
      }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = [];
  for (const throttle of [1, 4])
    for (const v of VARIANTS)
      for (const device of Object.keys(DEVICES)) {
        const rows = results.filter((r) => r.cpuThrottle === throttle && r.variant === v && r.device === device);
        const gap = (label) => median(rows.map((r) => r.windows.find((w) => w.label === label)?.maxGapMs ?? 0));
        summary.push({
          variant: v,
          device,
          cpuThrottle: throttle,
          runs: rows.length,
          clsMax: Math.max(...rows.map((r) => r.cls)),
          inpProxyMedianMs: median(rows.map((r) => r.inpProxyMs)),
          inpProxyMaxMs: Math.max(...rows.map((r) => r.inpProxyMs)),
          idleBaselineGapMs: gap('idle-baseline'),
          screenSwitchGapMs: gap('[data-act="continue"]'),
          addStepGapMs: gap('add-step'),
          worstFrameGapMedianMs: median(rows.map((r) => r.worstFrameGapMs)),
        });
      }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, 'metrics.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), base: BASE, chromium: browser.version(), note: 'Local fixture prototype in headless Chromium on Apple silicon; measures layout and interaction cost only, not production data paths. cpuThrottle 4 is the low-end proxy.', summary, results }, null, 2)}\n`,
  );
}

// Checks for the claims the independent review challenged; written to evidence/probes.json.
async function probes(browser) {
  const out = {};
  const open = async (device, q, viewport) => {
    const ctx = await browser.newContext({ ...DEVICES[device], ...(viewport ? { viewport } : {}), reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(url(q));
    await settle(page);
    return { ctx, page };
  };
  // 1. Optimistic hide actually removes the item in every variant (M5).
  out.optimistic = {};
  for (const v of VARIANTS) {
    const { ctx, page } = await open('desktop', { v, screen: 'home' });
    const count = () => page.locator('[data-act="snooze"]').count();
    const before = await count();
    await page.locator('[data-act="snooze"]').first().click();
    await page.waitForTimeout(400);
    const after = await count();
    await page.locator('.toast-action').first().click();
    await page.waitForTimeout(400);
    out.optimistic[v] = { before, afterHide: after, afterUndo: await count() };
    await ctx.close();
  }
  // 2. Phone: asking for help from the bar keeps the concerned step on screen (W1, W2).
  {
    const { ctx, page } = await open('mobile', { v: 'a', screen: 'work' });
    await page.locator('[data-act="hint2"]').filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const step = box('[data-step="s5"] .a-step-body');
      const bar = box('.a-context');
      const actions = box('.a-actions');
      const hint = box('[data-note-for="s5"] .a-note-body');
      return { stepTop: Math.round(step.top), stepBottom: Math.round(step.bottom), contextBarBottom: Math.round(bar.bottom), actionsTop: Math.round(actions.top), helpTop: Math.round(hint.top), viewport: innerHeight };
    });
    r.stepFullyVisible = r.stepTop >= r.contextBarBottom && r.stepBottom <= r.actionsTop;
    r.helpStartsOnScreen = r.helpTop < r.actionsTop;
    out.phoneHelp = r;
    await page.screenshot({ path: join(OUT, 'states', 'a-work-help-open-mobile.webp.png') });
    toWebp(await page.screenshot(), join(OUT, 'states', 'a-work-help-open-mobile.webp'));
    rmSync(join(OUT, 'states', 'a-work-help-open-mobile.webp.png'), { force: true });
    await ctx.close();
  }
  // 3. Margin-note anchoring at 1440: note top vs its step top (W3).
  {
    const { ctx, page } = await open('desktop', { v: 'a', screen: 'work' });
    out.anchors1440 = await page.evaluate(() =>
      ['s1', 's4', 's5'].map((id) => {
        const step = document.querySelector(`[data-step="${id}"] .a-step-body`).getBoundingClientRect();
        const note = document.querySelector(`[data-note-for="${id}"]`).getBoundingClientRect();
        return { step: id, offsetPx: Math.round(note.top - step.top) };
      }),
    );
    await ctx.close();
  }
  // 4. Laptop width keeps the stem pinned and notes inline (W2).
  out.layout = {};
  for (const width of [1280, 1024, 1023]) {
    const { ctx, page } = await open('desktop', { v: 'a', screen: 'work' }, { width, height: 800 });
    out.layout[width] = await page.evaluate(() => ({
      stemPosition: getComputedStyle(document.querySelector('.a-problem')).position,
      noteToggleVisible: getComputedStyle(document.querySelector('.a-note-toggle')).display !== 'none',
      stemPeekButton: getComputedStyle(document.querySelector('.a-peek-btn')).display !== 'none',
    }));
    await ctx.close();
  }
  // 5. Explanation label follows the committed state, not the stream (W6).
  {
    const { ctx, page } = await open('desktop', { v: 'a', screen: 'work' });
    await page.locator('[data-act="explain"]').first().click();
    const seen = [];
    for (let i = 0; i < 40; i++) {
      const label = await page.locator('.explain .tmp-badge, .explain .hint-at').first().textContent().catch(() => null);
      if (label && seen[seen.length - 1] !== label) seen.push(label);
      if (label?.startsWith('已记为')) break;
      await page.waitForTimeout(100);
    }
    out.explainLabels = seen;
    toWebp(await page.screenshot(), join(OUT, 'states', 'a-work-explain-recorded-desktop.webp'));
    await ctx.close();
  }
  // 6. AI suggestions failing leaves deterministic items in place (H6, H7).
  out.errorStateDeterministic = {};
  for (const v of VARIANTS) {
    const { ctx, page } = await open('desktop', { v, screen: 'home', state: 'error' });
    out.errorStateDeterministic[v] = await page.getByText('到期复习 · 4 项').count();
    await ctx.close();
  }
  writeFileSync(join(OUT, 'probes.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

const [mode = 'all', ...rest] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  if (mode === 'quick') {
    const [v = 'a', screen = 'home', theme = 'light', device = 'desktop', extra = ''] = rest;
    const q = { v, screen, theme, ...Object.fromEntries(new URLSearchParams(extra)) };
    await shoot(browser, device, q, `/tmp/loft-${v}-${screen}-${theme}-${device}.png`, { full: true });
  }
  if (mode === 'flowcheck')
    for (const v of VARIANTS)
      for (const device of Object.keys(DEVICES)) {
        const ctx = await browser.newContext(DEVICES[device]);
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        await page.goto(url({ v, screen: 'home', theme: 'light' }));
        await settle(page);
        try {
          await flow(page, device);
          const kept = await page.evaluate(() => document.location.search);
          console.log('flow ok', v, device, kept, errors.length ? errors : '');
        } catch (e) {
          console.log('flow FAIL', v, device, e.message.split('\n')[0], errors);
        }
        await ctx.close();
      }
  if (mode === 'shots' || mode === 'all') await shots(browser);
  if (mode === 'states' || mode === 'all') await states(browser);
  if (mode === 'video' || mode === 'all') await video(browser);
  if (mode === 'round1') {
    // Approximate structural reconstruction of A before the in-loft revision (no top-bar
    // destinations, no phone tab bar, no pinned stem). It shares later fixes, so it is NOT the
    // original record: the original round-1 captures live in round-1/original and are never touched.
    const dir = join(OUT, 'round-1', 'reconstructed');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const screen of ['home', 'work'])
      for (const device of Object.keys(DEVICES))
        for (const theme of ['light', 'dark'])
          await shoot(browser, device, { v: 'a', round: '1', screen, theme }, join(dir, `a-${screen}-${device}-${theme}.webp`), { full: device === 'mobile' });
  }
  if (mode === 'probes' || mode === 'all') await probes(browser);
  if (mode === 'metrics' || mode === 'all') await metrics(browser);
} finally {
  await browser.close();
}
