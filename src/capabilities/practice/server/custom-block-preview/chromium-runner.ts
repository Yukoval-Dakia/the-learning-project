import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { Browser } from 'playwright-core';
import type { CustomBlockT } from '@/core/schema/assessment/presentation';
import type { ResponseSlotT } from '@/core/schema/assessment/response';
import {
  MAX_MESSAGE_BYTES,
  buildInit,
  buildShell,
  frameHeight,
  validateMessage,
} from '../../ui/blocks/custom-sandbox';
import { createLinuxIsolation } from './linux-isolation';
import { type HostEvent, drainPreviewEvents, installPreviewHost } from './preview-host';
import { type BlockPreviewEvidence, PreviewError, type PreviewLimits } from './types';

type PlaywrightCore = typeof import('playwright-core');

/** A concrete invocation, not an import-time daemon or a user-provided runner. */
export async function previewBlockInChromium(
  block: CustomBlockT,
  code: string,
  slots: ReadonlyMap<string, ResponseSlotT>,
  limits: PreviewLimits,
  signal?: AbortSignal,
): Promise<BlockPreviewEvidence> {
  const started = Date.now();
  const deadline = started + limits.total_ms;
  const observed = new Set<string>();
  let sandboxConfirmed = false;
  let focusObservedMs = 0;
  let readyReceived = false;
  let killRequested = false;
  let emptyConfirmed = false;
  let isolation: Awaited<ReturnType<typeof createLinuxIsolation>> | undefined;
  let browser: Browser | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: PreviewError | undefined;
  let stopped = false;
  let onAbort: (() => void) | undefined;
  const assertTime = () => {
    signal?.throwIfAborted();
    if (stopped || Date.now() >= deadline) throw new PreviewError('timeout');
  };
  try {
    isolation = await createLinuxIsolation(limits);
    assertTime();
    const boundary = isolation;
    const requireHere = createRequire(join(process.cwd(), 'package.json'));
    const { chromium } = requireHere('playwright-core') as PlaywrightCore;
    const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!browserRoot || !isAbsolute(browserRoot) || !['x64', 'arm64'].includes(process.arch)) {
      throw new PreviewError('isolation_unavailable', 'absolute_headless_shell_root_required');
    }
    // The current worker installs only chromium-headless-shell, not headed Chromium.
    // Resolve the revision from the installed dependency, never download a browser here.
    const manifest = JSON.parse(
      await readFile(
        join(dirname(requireHere.resolve('playwright-core/package.json')), 'browsers.json'),
        'utf8',
      ),
    ) as { browsers: { name: string; revision: string }[] };
    const revision = manifest.browsers.find((b) => b.name === 'chromium-headless-shell')?.revision;
    if (!revision || !/^\d+$/.test(revision))
      throw new PreviewError('isolation_unavailable', 'headless_shell_revision_missing');
    const executable = join(
      browserRoot,
      `chromium_headless_shell-${revision}`,
      process.arch === 'arm64'
        ? 'chrome-headless-shell-linux-arm64'
        : 'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    );
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw new PreviewError('isolation_unavailable', 'headless_shell_not_installed');
    }
    assertTime();
    let rejectFailure: (error: PreviewError) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    const reject = (error: PreviewError) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      rejectFailure(error);
      // Hard kernel process-tree kill; never depend on browser.close responding.
      void boundary.kill().catch(() => {});
    };
    onAbort = () => reject(new PreviewError('timeout', 'delivery_cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    assertTime();
    deadlineTimer = setTimeout(() => reject(new PreviewError('timeout')), deadline - Date.now());
    const work = async () => {
      assertTime();
      browser = await chromium.launch({
        executablePath: '/bin/sh',
        chromiumSandbox: true,
        ignoreDefaultArgs: true,
        // /bin/sh gets no Chromium defaults; this complete argv keeps sandbox ON and uses
        // inherited anonymous debugging pipes, not any listening TCP/WS port.
        args: [
          boundary.launcher,
          boundary.cgroup,
          `${(deadline - Date.now()) / 1000}s`,
          executable,
          '--headless',
          '--remote-debugging-pipe',
          '--enable-automation',
          '--no-startup-window',
          `--user-data-dir=${boundary.profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-component-update',
          '--disable-sync',
          '--disable-breakpad',
          '--disable-dev-shm-usage',
          '--password-store=basic',
          '--use-mock-keychain',
        ],
        env: boundary.env,
        timeout: Math.max(1, deadline - Date.now()),
      });
      assertTime();
      const context = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: false,
        permissions: [],
        offline: true,
      });
      await context.route('**/*', async (route) => {
        if (route.request().isNavigationRequest()) reject(new PreviewError('navigation'));
        try {
          await route.abort();
        } catch {
          if (!stopped) reject(new PreviewError('browser_failed'));
        }
      });
      await context.routeWebSocket('**/*', (socket) => {
        socket.close();
      });
      const page = await context.newPage();
      context.on('page', () => reject(new PreviewError('navigation')));
      page.on('pageerror', () => reject(new PreviewError('load_throw')));
      page.on('crash', () => reject(new PreviewError('browser_failed')));
      const session = await context.newCDPSession(page);
      const command = await session.send('Browser.getBrowserCommandLine');
      if (
        command.arguments.some((arg) =>
          /^(--no-sandbox|--disable-setuid-sandbox|--disable-seccomp-filter-sandbox|--single-process)(=|$)/.test(
            arg,
          ),
        )
      ) {
        throw new PreviewError('sandbox_unconfirmed', 'forbidden_chromium_flag');
      }
      await boundary.confirmSandbox(executable);
      sandboxConfirmed = true;
      let ready = false;
      let readyResolve: () => void = () => {};
      const handshake = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      const onEvent = (event: HostEvent) => {
        if (stopped) return;
        if (event.type === 'loaded') {
          if (readyTimer) {
            reject(new PreviewError('navigation'));
            return;
          }
          readyTimer = setTimeout(
            () => reject(new PreviewError('timeout', 'ready_deadline')),
            limits.ready_ms,
          );
        } else if (event.type === 'message') {
          const data = event.data;
          if (!ready) {
            if (data !== 'ready') {
              reject(new PreviewError('invalid_envelope'));
              return;
            }
            ready = true;
            readyReceived = true;
            if (readyTimer) clearTimeout(readyTimer);
            readyResolve();
            return;
          }
          const entries = validateMessage(data, block.binds, slots);
          if (!entries) {
            reject(new PreviewError('invalid_envelope'));
            return;
          }
          for (const entry of entries) observed.add(entry.slot_id);
        } else if (
          event.type === 'focus_grab_after_use' ||
          event.type === 'focus_abuse' ||
          event.type === 'navigation' ||
          event.type === 'invalid_envelope'
        ) {
          reject(new PreviewError(event.type));
        } else {
          reject(new PreviewError('browser_failed'));
        }
      };
      const navigations = new Set<string>();
      page.on('framenavigated', (frame) => {
        // about:srcdoc is allowed exactly once for the single expected child frame.
        if (
          frame === page.mainFrame() ||
          frame.url() !== 'about:srcdoc' ||
          navigations.has(frame.url())
        ) {
          reject(new PreviewError('navigation'));
        } else {
          navigations.add(frame.url());
        }
      });
      await installPreviewHost(
        page,
        buildShell(code, block.sandbox.entry),
        buildInit(block.binds, slots, [], false),
        MAX_MESSAGE_BYTES,
        frameHeight(block),
      );
      const monitor = async () => {
        while (!stopped) {
          for (const event of await drainPreviewEvents(page)) onEvent(event);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      };
      void monitor().catch(() => reject(new PreviewError('browser_failed')));
      await handshake;
      assertTime();
      await boundary.confirmSandbox(executable);
      await page.locator('#activate').click({ timeout: Math.max(1, deadline - Date.now()) });
      await page.locator('iframe').click({ timeout: Math.max(1, deadline - Date.now()) });
      await page.locator('#outside').click({ timeout: Math.max(1, deadline - Date.now()) });
      // A full approved observation window must fit; truncating it is never a pass.
      if (Date.now() + limits.focus_observation_ms >= deadline) throw new PreviewError('timeout');
      const observationStarted = Date.now();
      await page.waitForTimeout(limits.focus_observation_ms);
      focusObservedMs = Date.now() - observationStarted;
      for (const event of await drainPreviewEvents(page)) onEvent(event);
      assertTime();
      if (block.binds.some((bind) => !observed.has(bind.slot_id)))
        throw new PreviewError('missing_bind');
      await boundary.confirmSandbox(executable);
      for (const event of await drainPreviewEvents(page)) onEvent(event);
      assertTime();
    };
    await Promise.race([work(), failed]);
  } catch (error) {
    failure ??=
      error instanceof PreviewError
        ? error
        : error instanceof Error && error.name === 'TimeoutError'
          ? new PreviewError('timeout')
          : sandboxConfirmed
            ? new PreviewError('browser_failed')
            : new PreviewError('isolation_unavailable', 'browser_or_namespace_startup_failed');
  } finally {
    stopped = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (readyTimer) clearTimeout(readyTimer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (isolation) {
      try {
        // Kill before inspecting counters/cleaning the profile; no live process outlives it.
        await isolation.kill();
        killRequested = true;
        if (await isolation.memoryExceeded()) failure = new PreviewError('memory_limit');
      } catch {
        failure = new PreviewError('cleanup_failed');
      } finally {
        try {
          await isolation.cleanup();
          killRequested = true;
          emptyConfirmed = true;
        } catch {
          failure = new PreviewError('cleanup_failed');
        }
      }
    }
    // cgroup.kill already terminated every descendant; release Playwright's pipe handles.
    if (browser) void browser.close().catch(() => {});
  }
  signal?.throwIfAborted();
  return {
    block_id: block.block_id,
    asset: { ...block.sandbox.asset },
    entry: block.sandbox.entry,
    binds: block.binds.map((bind) => ({ ...bind })),
    status: failure
      ? failure.reason === 'isolation_unavailable' || failure.reason === 'sandbox_unconfirmed'
        ? 'unavailable'
        : 'rejected'
      : 'passed',
    ...(failure
      ? {
          reason: failure.reason,
          ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
        }
      : {}),
    observed_slots: [...observed].sort(),
    elapsed_ms: Date.now() - started,
    sandbox_confirmed: sandboxConfirmed,
    memory_enforcement: sandboxConfirmed ? 'cgroup-v2' : 'unavailable',
    network_enforcement: sandboxConfirmed ? 'linux-network-namespace' : 'unavailable',
    enforced_limits: sandboxConfirmed
      ? { memory_bytes: limits.memory_bytes, total_ms: limits.total_ms }
      : null,
    focus_out_observed_ms: focusObservedMs,
    ready_received: readyReceived,
    termination: isolation
      ? { method: 'cgroup.kill', requested: killRequested, empty_confirmed: emptyConfirmed }
      : null,
  };
}
