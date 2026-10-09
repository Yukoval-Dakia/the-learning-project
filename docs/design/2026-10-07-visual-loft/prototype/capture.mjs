// Evidence capture for the YUK-1353 product prototype: screenshots, states, mid-flight motion
// frames, recordings, probes and metrics, all in real Chromium. Needs the loft dev server
// (see vite.config.mjs) and network access for three.js (the mascot loads it from a CDN).
//   node docs/design/2026-10-07-visual-loft/prototype/capture.mjs shots|states|motion|video|probes|metrics|all
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.LOFT_URL ?? 'http://localhost:5199/';
const OUT = join(import.meta.dirname, '..', 'evidence');
const PAGES = ['home', 'question', 'note', 'library'];
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
// The mascot is WebGL. LOFT_GL=metal (default on macOS) draws it on the real GPU; LOFT_GL=swiftshader
// draws it in software, which stands in for devices without GPU acceleration.
const GL = process.env.LOFT_GL ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const LAUNCH = {
  args: GL === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

const url = (q) => `${BASE}?${new URLSearchParams(q)}`;
const dir = (name) => {
  const d = join(OUT, name);
  mkdirSync(d, { recursive: true });
  return d;
};

async function settle(page, ms = 600) {
  await page.evaluate(() => document.fonts.ready);
  // Wait for the mascot's first WebGL frame (three.js arrives from the CDN).
  await page
    .waitForFunction(() => {
      const c = document.querySelector('.mascot-canvas');
      return !c || c.width !== 300; // three.js has sized the drawing buffer
    }, null, { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(ms);
}

function toWebp(png, dest) {
  const tmp = `${dest}.png`;
  writeFileSync(tmp, png);
  execFileSync('cwebp', ['-quiet', '-q', '86', '-m', '6', tmp, '-o', dest]);
  rmSync(tmp);
}

async function open(browser, device, q, { motion = false, init } = {}) {
  const ctx = await browser.newContext({ ...DEVICES[device], reducedMotion: motion ? 'no-preference' : 'reduce' });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url(q));
  await settle(page);
  return { ctx, page, errors };
}

async function shot(page, dest, locator) {
  const png = await (locator ?? page).screenshot();
  toWebp(png, dest);
  console.log('shot', dest);
}

/* ── Interactions shared by states, motion, video, probes and metrics ── */
const act = (page, device) => ({
  async tap(loc) {
    const l = typeof loc === 'string' ? page.locator(loc).filter({ visible: true }).first() : loc;
    await l.scrollIntoViewIfNeeded();
    if (device === 'mobile') await l.tap();
    else await l.click();
  },
  async capture(text) {
    if (device === 'mobile') {
      await this.tap('.tab-capture');
      await page.waitForTimeout(450);
      await page.locator('.capture-sheet textarea').fill(text);
      await this.tap('.capture-sheet button[type=submit]');
    } else {
      await page.getByLabel('快速记录').fill(text);
      await page.keyboard.press('Enter');
    }
  },
  async ask(text) {
    await page.locator('.copilot-compose textarea').fill(text);
    await page.keyboard.press('Enter');
  },
  async selectInNote(anchor, share = 0.7) {
    const box = await page.locator(`.note-sec[data-anchor="${anchor}"] .note-p`).boundingBox();
    await page.mouse.move(box.x + 4, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * share, box.y + 8, { steps: 8 });
    await page.mouse.up();
  },
});

/* ── Screens: 4 pages × desktop/phone × light/dark ───── */
async function shots(browser) {
  const d = dir('screens');
  for (const p of PAGES)
    for (const device of Object.keys(DEVICES))
      for (const theme of ['light', 'dark']) {
        const { ctx, page } = await open(browser, device, { page: p, theme });
        await shot(page, join(d, `${p}-${device}-${theme}.webp`));
        await ctx.close();
      }
}

/* ── States: the moments the rules talk about ─────────── */
async function states(browser) {
  const d = dir('states');
  const run = async (device, q, name, steps, { motion = false, target } = {}) => {
    const { ctx, page } = await open(browser, device, q, { motion });
    await steps(page, act(page, device));
    await shot(page, join(d, `${name}.webp`), target ? page.locator(target) : undefined);
    await ctx.close();
  };
  await run('desktop', { page: 'home' }, 'home-captured-desktop', async (page, a) => {
    await a.capture('课上老师说双曲线的渐近线题下周会考');
    await page.waitForTimeout(900);
  });
  await run('desktop', { page: 'home' }, 'home-why-open-desktop', async (page) => {
    await page.locator('.card .link-btn').first().click();
    await page.waitForTimeout(500);
  });
  await run('desktop', { page: 'home' }, 'home-sidebar-collapsed-desktop', async (page) => {
    await page.keyboard.press('Meta+\\');
    await page.waitForTimeout(600);
  });
  await run('desktop', { page: 'question' }, 'question-copilot-streaming', async (page, a) => {
    await a.ask('那我应该怎么写单调性？');
    await page.waitForSelector('.msg.is-streaming');
    await page.waitForTimeout(500);
  }, { motion: true, target: '.copilot' });
  await run('desktop', { page: 'question' }, 'question-copilot-recording', async (page, a) => {
    await a.ask('那我应该怎么写单调性？');
    await page.waitForSelector('.msg.is-confirming', { timeout: 15000 });
    await page.waitForTimeout(200);
  }, { motion: true, target: '.copilot' });
  await run('desktop', { page: 'question' }, 'question-copilot-settled', async (page, a) => {
    await a.ask('那我应该怎么写单调性？');
    await page.waitForSelector('.msg.is-settled', { timeout: 15000 });
    await page.waitForTimeout(600);
  }, { motion: true, target: '.copilot' });
  await run('desktop', { page: 'question' }, 'question-ref-reveals-step', async (page) => {
    await page.locator('button.msg-ref', { hasText: '第 5 步' }).click();
    await page.waitForTimeout(450);
  }, { motion: true });
  await run('desktop', { page: 'note' }, 'note-ask-bubble', async (page, a) => {
    await a.selectInNote('最值的陷阱');
    await page.waitForTimeout(400);
  });
  await run('desktop', { page: 'note' }, 'note-quote-landed', async (page, a) => {
    await a.selectInNote('最值的陷阱');
    await page.waitForTimeout(300);
    await page.locator('.ask-bubble button').click();
    await page.waitForSelector('.msg.is-settled', { timeout: 15000 });
    await page.waitForTimeout(400);
  });
  await run('desktop', { page: 'note' }, 'note-mark-reveals-message', async (page) => {
    await page.locator('.note-sec[data-anchor="直线怎么设"] .cite-mark').click();
    await page.waitForTimeout(450);
  }, { motion: true });
  await run('desktop', { page: 'home', theme: 'dark' }, 'palette-dark', async (page) => {
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('椭圆');
    await page.waitForTimeout(400);
  });
  await run('mobile', { page: 'home' }, 'phone-capture-sheet', async (page, a) => {
    await a.tap('.tab-capture');
    await page.waitForTimeout(500);
    await page.locator('.capture-sheet textarea').fill('物理：动量守恒那节再看一次');
  });
  await run('mobile', { page: 'home' }, 'phone-scrolled-docked', async (page) => {
    await page.locator('.scroll').evaluate((e) => e.scrollBy(0, 520));
    await page.waitForTimeout(900);
  }, { motion: true });
  await run('mobile', { page: 'question' }, 'phone-copilot-half', async (page, a) => {
    await a.tap(page.locator('.tab', { hasText: '学习伙伴' }));
    await page.waitForTimeout(900);
  }, { motion: true });
  await run('mobile', { page: 'question' }, 'phone-ref-reveals-step', async (page, a) => {
    await a.tap(page.locator('.tab', { hasText: '学习伙伴' }));
    await page.waitForTimeout(900);
    await a.tap(page.locator('button.msg-ref', { hasText: '第 5 步' }));
    await page.waitForTimeout(900);
  }, { motion: true });
}

/* ── Motion: frames taken mid-flight ──────────────────── */
async function motion(browser) {
  const d = dir('motion');
  const frame = async (device, q, name, start, at) => {
    const { ctx, page } = await open(browser, device, q, { motion: true });
    await start(page, act(page, device));
    await page.waitForTimeout(at);
    await shot(page, join(d, `${name}.webp`));
    await ctx.close();
  };
  await frame('desktop', { page: 'home' }, 'morph-card-to-title', (page) => page.locator('.card-continue').click(), 160);
  await frame('desktop', { page: 'question' }, 'morph-title-back-to-card', (page) => page.locator('.side-item', { hasText: '回来时' }).first().click(), 160);
  await frame('desktop', { page: 'library' }, 'morph-row-to-title', (page) => page.locator('.lib-row').first().click(), 160);
  await frame('desktop', { page: 'home' }, 'capture-into-inbox', (_page, a) => a.capture('课上老师说双曲线的渐近线题下周会考'), 220);
  await frame('mobile', { page: 'home' }, 'phone-capture-into-tab', (_page, a) => a.capture('物理：动量守恒那节再看一次'), 220);
  await frame(
    'desktop',
    { page: 'note' },
    'quote-into-conversation',
    async (page, a) => {
      await a.selectInNote('最值的陷阱');
      await page.waitForTimeout(300);
      await page.locator('.ask-bubble button').click();
    },
    480,
  );
}

/* ── Recordings ───────────────────────────────────────── */
async function flow(page, device, mark = async () => {}) {
  const a = act(page, device);
  const step = async (label, fn, after = 700) => {
    await mark(label);
    await fn();
    await page.waitForTimeout(after);
  };
  await page.waitForTimeout(800);
  if (device === 'desktop') {
    await step('capture', () => a.capture('课上老师说双曲线的渐近线题下周会考'), 1100);
    await step('why', () => page.locator('.card .link-btn').first().click());
    await step('postpone', () => page.locator('.row .link-btn').first().click());
    await step('undo', () => page.locator('.toast button').first().click());
    await step('screen-switch', () => page.locator('.card-continue').click(), 1000);
    await step('reveal', () => page.locator('button.msg-ref', { hasText: '第 5 步' }).click(), 1200);
    await step('panel-close', () => page.keyboard.press('Meta+j'), 800);
    await step('panel-open', () => page.keyboard.press('Meta+j'), 800);
    await step('ask', () => a.ask('那我应该怎么写单调性？'), 5600);
    await step('proposal', () => page.locator('.proposal .btn-secondary').click(), 900);
    await step('to-library', () => page.locator('.crumbs button', { hasText: '资料' }).click(), 900);
    await step('tab', () => page.locator('.seg button', { hasText: '笔记' }).click(), 700);
    await step('row-to-note', () => page.locator('.lib-row', { hasText: '设而不求' }).click(), 1100);
    await a.selectInNote('最值的陷阱');
    await page.waitForTimeout(400);
    await step('quote', () => page.locator('.ask-bubble button').click(), 5800);
    await step('cite-mark', () => page.locator('.note-sec[data-anchor="直线怎么设"] .cite-mark').click(), 1200);
    await step('palette', async () => {
      await page.keyboard.press('Meta+k');
      await page.waitForTimeout(350);
      await page.keyboard.type('回来', { delay: 60 });
      await page.keyboard.press('Enter');
    }, 1300);
  } else {
    await step('capture', () => a.capture('物理：动量守恒那节再看一次'), 1200);
    await step('scroll-dock', () => page.locator('.scroll').evaluate((e) => e.scrollBy({ top: 520, behavior: 'smooth' })), 1100);
    await step('scroll-back', () => page.locator('.scroll').evaluate((e) => e.scrollTo({ top: 0, behavior: 'smooth' })), 1000);
    await step('screen-switch', () => a.tap('.card-continue'), 1100);
    await step('sheet-half', () => a.tap(page.locator('.tab', { hasText: '学习伙伴' })), 900);
    await step('reveal', () => a.tap(page.locator('button.msg-ref', { hasText: '第 5 步' })), 1300);
    await step('back', () => a.tap('.topbar-back'), 1000);
    await step('row-to-question', () => a.tap(page.locator('.lib-row').first()), 1100);
    await step('to-library', () => a.tap('.topbar-back'), 900);
  }
}

async function video(browser) {
  const d = dir('video');
  for (const device of Object.keys(DEVICES)) {
    const raw = join(d, `raw-${device}`);
    const size = DEVICES[device].viewport;
    const ctx = await browser.newContext({ ...DEVICES[device], recordVideo: { dir: raw, size } });
    const page = await ctx.newPage();
    await page.goto(url({ page: 'home' }));
    await settle(page);
    await flow(page, device);
    await ctx.close();
    const webm = readdirSync(raw).find((f) => f.endsWith('.webm'));
    const mp4 = join(d, `${device}-flow.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(raw, webm), '-c:v', 'libx264', '-crf', '30', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    rmSync(raw, { recursive: true });
    console.log('video', mp4);
  }
}

/* ── Probes: each motion claim, measured ──────────────── */
async function probes(browser) {
  const out = {};
  const errors = [];
  const ghosts = (page) => page.evaluate(() => [...document.body.children].filter((e) => e.style?.position === 'fixed').length);
  const hidden = (page) => page.evaluate(() => [...document.querySelectorAll('[data-morph],[data-quote]')].filter((e) => e.style.visibility === 'hidden').length);
  const go = async (device, q, opts) => {
    const r = await open(browser, device, q, { motion: true, ...opts });
    errors.push(...r.errors.map((e) => `${device} ${q.page}: ${e}`));
    return r;
  };

  // Capture travels into the inbox; the count follows landing and undo.
  for (const device of Object.keys(DEVICES)) {
    const { ctx, page } = await go(device, { page: 'home' });
    const badge = device === 'mobile' ? '.tab-badge .roll-now' : '.side-pocket .side-badge .roll-now';
    const read = () => page.locator(badge).innerText();
    const before = await read();
    await act(page, device).capture('一句要记下的话');
    await page.waitForTimeout(240);
    const inFlight = await page.locator('.fly-chip').count();
    await page.waitForTimeout(900);
    const landed = await read();
    await page.locator('.toast button').first().click();
    await page.waitForTimeout(500);
    out[`capture_${device}`] = { before, chipsInFlight: inFlight, afterLanding: landed, afterUndo: await read(), chipsLeft: await page.locator('.fly-chip').count() };
    await ctx.close();
  }
  // Undo while the chip is still flying must not count it.
  {
    const { ctx, page } = await go('desktop', { page: 'home' });
    await act(page, 'desktop').capture('撤销得很快的一句');
    await page.waitForTimeout(120);
    await page.locator('.toast button').first().click();
    await page.waitForTimeout(1000);
    out.capture_undoMidFlight = { inbox: await page.locator('.side-pocket .side-badge .roll-now').innerText() };
    await ctx.close();
  }
  // Shared-title morph: ghosts while flying, none left, target visible; interrupted twice.
  for (const reduce of [false, true]) {
    const { ctx, page } = await go('desktop', { page: 'home' }, { motion: !reduce });
    await page.locator('.card-continue').click();
    await page.waitForTimeout(150);
    const mid = await ghosts(page);
    await page.locator('.side-item', { hasText: '回来时' }).first().click();
    await page.waitForTimeout(120);
    await page.locator('.side-item', { hasText: '资料' }).first().click();
    await page.waitForTimeout(100);
    await page.locator('.lib-row').first().click();
    await page.waitForTimeout(900);
    out[reduce ? 'morph_reducedMotion' : 'morph_interrupted'] = { ghostsMidFlight: mid, ghostsAfter: await ghosts(page), hiddenTargetsAfter: await hidden(page), endedOn: new URL(page.url()).searchParams.get('page') };
    await ctx.close();
  }
  // Streaming → settled is one element; the receipt folds away.
  {
    const { ctx, page } = await go('desktop', { page: 'question' });
    await act(page, 'desktop').ask('那我应该怎么写单调性？');
    await page.waitForSelector('.msg.is-temp');
    const el = await page.locator('.msg.is-temp').elementHandle();
    await el.evaluate((e) => {
      window.__phases = [];
      new MutationObserver(() => window.__phases.at(-1) !== e.className && window.__phases.push(e.className)).observe(e, { attributes: true });
    });
    await page.waitForSelector('.msg.is-settled', { timeout: 15000 });
    const sameNode = await el.evaluate((e) => e.isConnected && e.classList.contains('is-settled'));
    const colors = await el.evaluate((e) => getComputedStyle(e.querySelector('p')).transitionDuration);
    await page.waitForTimeout(2600);
    out.settle = {
      sameElementFromFirstTokenToRecord: sameNode,
      phases: await page.evaluate(() => window.__phases.map((c) => c.replace('msg msg-ai', '').trim())),
      textColorTransition: colors,
      receiptHeightAfterFold: await page.locator('.msg.is-settled .tmp-badge').evaluate((e) => Math.round(e.getBoundingClientRect().height)).catch(() => 'removed'),
    };
    await ctx.close();
  }
  // Content ↔ conversation, both ways, and the quote keeps its formula.
  {
    const { ctx, page } = await go('desktop', { page: 'question' });
    const top0 = await page.locator('.scroll').evaluate((e) => e.scrollTop);
    await page.locator('button.msg-ref', { hasText: '第 5 步' }).click();
    await page.waitForTimeout(500);
    out.refToStep = { scrolledPx: (await page.locator('.scroll').evaluate((e) => e.scrollTop)) - top0, glowing: await page.locator('.step.is-flash').getAttribute('data-anchor') };
    await ctx.close();
  }
  {
    const { ctx, page } = await go('desktop', { page: 'note' });
    const marksBefore = await page.locator('.cite-mark').count();
    await act(page, 'desktop').selectInNote('最值的陷阱');
    await page.waitForTimeout(300);
    await page.locator('.ask-bubble button').click();
    await page.waitForTimeout(500);
    const ghostMid = await page.locator('.quote-ghost').count();
    await page.waitForTimeout(900);
    const quote = page.locator('.msg-quote').last();
    out.quote = {
      ghostMidFlight: ghostMid,
      landedVisible: (await quote.evaluate((e) => getComputedStyle(e).visibility)) === 'visible',
      formulasRendered: await quote.locator('.katex').count(),
      citeMarksBefore: marksBefore,
      citeMarksAfter: await page.locator('.cite-mark').count(),
    };
    await page.locator('.note-sec[data-anchor="直线怎么设"] .cite-mark').click();
    await page.waitForTimeout(500);
    out.markToMessage = { glowingMessages: await page.locator('.copilot-list .is-flash').count() };
    await page.locator('.msg-quote').first().click();
    await page.waitForTimeout(500);
    out.quoteToPassage = { glowing: await page.locator('.note-sec.is-flash').getAttribute('data-anchor') };
    await ctx.close();
  }
  // Reading position while the panel opens and closes (1180 wide, where the column reflows).
  {
    const { ctx, page } = await go('desktop', { page: 'question' });
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.waitForTimeout(500);
    const sel = '.step[data-anchor="第 3 步"]';
    const top = () => page.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().top), sel);
    const place = () =>
      page.locator('.scroll').evaluate((e, s) => {
        e.scrollTop += document.querySelector(s).getBoundingClientRect().top - e.getBoundingClientRect().top - 140;
      }, sel);
    await place();
    await page.waitForTimeout(150);
    let t0 = await top();
    // Baseline: flip the layout class behind the app's back, so nothing pins the paragraph.
    await page.evaluate(() => document.querySelector('.app').classList.remove('has-copilot'));
    await page.waitForTimeout(700);
    const unpinned = (await top()) - t0;
    await page.evaluate(() => document.querySelector('.app').classList.add('has-copilot'));
    await page.waitForTimeout(700);
    await place();
    await page.waitForTimeout(150);
    t0 = await top();
    await page.keyboard.press('Meta+j');
    const pinned = [];
    for (let i = 0; i < 9; i++) {
      await page.waitForTimeout(60);
      pinned.push((await top()) - t0);
    }
    out.readingPosition = { viewport: '1180×760', anchor: sel, driftWithoutPinPx: unpinned, driftWhilePanelClosesPx: pinned };
    await ctx.close();
  }
  // Phone: a reference in the sheet lowers it to peek and reveals the step.
  {
    const { ctx, page } = await go('mobile', { page: 'question' });
    const a = act(page, 'mobile');
    await a.tap(page.locator('.tab', { hasText: '学习伙伴' }));
    await page.waitForTimeout(800);
    const before = (await page.locator('.copilot').getAttribute('class')).match(/snap-\w+/)[0];
    await a.tap(page.locator('button.msg-ref', { hasText: '第 5 步' }));
    await page.waitForTimeout(800);
    out.phoneRef = { sheetBefore: before, sheetAfter: (await page.locator('.copilot').getAttribute('class')).match(/snap-\w+/)[0], stepGlowing: await page.locator('.step.is-flash').count() };
    await ctx.close();
  }
  out.pageErrors = errors;
  writeFileSync(join(OUT, 'probes.json'), `${JSON.stringify({ capturedAt: new Date().toISOString(), chromium: browser.version(), ...out }, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 1));
}

/* ── Metrics: CLS, interaction time, frame gaps ───────── */
const OBSERVE = () => {
  const m = { cls: 0, events: [], windows: [] };
  window.__m = m;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) m.cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.interactionId) m.events.push({ id: e.interactionId, d: e.duration, name: e.name, t: Math.round(e.startTime) });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  window.__mark = (label) => {
    const w = { label, at: Math.round(performance.now()), gaps: [] };
    m.windows.push(w);
    const start = performance.now();
    let last = start;
    const tick = (t) => {
      w.gaps.push(t - last);
      last = t;
      if (t - start < 700) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
};

async function metrics(browser) {
  const runs = Number(process.env.LOFT_RUNS ?? 3);
  const results = [];
  for (let run = 1; run <= runs; run++)
    for (const throttle of [1, 4])
      for (const device of Object.keys(DEVICES)) {
        const ctx = await browser.newContext(DEVICES[device]);
        await ctx.addInitScript(OBSERVE);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await page.goto(url({ page: 'home' }));
        await settle(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        await page.evaluate(() => window.__mark('idle-baseline'));
        await page.waitForTimeout(900);
        await flow(page, device, (label) => page.evaluate((l) => window.__mark(l), label));
        const m = await page.evaluate(() => window.__m);
        await ctx.close();
        const byId = new Map();
        for (const e of m.events) byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.d));
        const durations = [...byId.values()].sort((x, y) => x - y);
        const windows = m.windows.map((w) => {
          const gaps = w.gaps.slice(1);
          return { label: w.label, frames: gaps.length, maxGapMs: Math.round(Math.max(0, ...gaps)), over20msShare: gaps.length ? Number((gaps.filter((g) => g > 20).length / gaps.length).toFixed(3)) : null };
        });
        const row = {
          run,
          device,
          cpuThrottle: throttle,
          cls: Number(m.cls.toFixed(4)),
          interactions: durations.length,
          inpProxyMs: durations.at(-1) ?? 0,
          medianInteractionMs: durations[Math.floor(durations.length / 2)] ?? 0,
          windows,
          slowestInteraction: (() => {
            const worst = [...m.events].sort((x, y) => y.d - x.d)[0];
            if (!worst) return null;
            const step = [...m.windows].reverse().find((w) => w.at <= worst.t + 5);
            return { ms: worst.d, event: worst.name, step: step?.label ?? null };
          })(),
        };
        results.push(row);
        console.log(device, `cpu×${throttle}`, `run ${run}`, `cls=${row.cls}`, `inp≈${row.inpProxyMs}ms`);
      }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = [];
  for (const throttle of [1, 4])
    for (const device of Object.keys(DEVICES)) {
      const rows = results.filter((r) => r.cpuThrottle === throttle && r.device === device);
      const labels = [...new Set(rows.flatMap((r) => r.windows.map((w) => w.label)))];
      summary.push({
        device,
        cpuThrottle: throttle,
        runs: rows.length,
        clsMax: Math.max(...rows.map((r) => r.cls)),
        inpProxyMedianMs: median(rows.map((r) => r.inpProxyMs)),
        inpProxyMaxMs: Math.max(...rows.map((r) => r.inpProxyMs)),
        medianInteractionMs: median(rows.map((r) => r.medianInteractionMs)),
        maxFrameGapMs: Object.fromEntries(labels.map((l) => [l, median(rows.map((r) => r.windows.find((w) => w.label === l)?.maxGapMs ?? 0))])),
      });
    }
  const renderer = GL === 'metal' ? 'Apple GPU via ANGLE Metal' : 'SwiftShader software WebGL';
  writeFileSync(
    join(OUT, GL === 'metal' ? 'metrics.json' : 'metrics-swiftshader.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), chromium: browser.version(), webgl: renderer, build: process.env.LOFT_BUILD ?? 'vite dev server (React development build)', base: BASE, note: 'Local fixture prototype in headless Chromium on Apple silicon; measures layout and interaction cost only. cpuThrottle 4 is the low-end proxy. Headless rAF cannot prove 60fps.', summary, results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 1));
}

const modes = { shots, states, motion, video, probes, metrics };
const which = process.argv[2] ?? 'all';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(LAUNCH);
try {
  for (const [name, fn] of Object.entries(modes)) if (which === 'all' || which === name) await fn(browser);
} finally {
  await browser.close();
}
