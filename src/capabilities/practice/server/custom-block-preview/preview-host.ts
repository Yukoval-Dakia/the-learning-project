import type { Page } from 'playwright-core';
import type { buildInit } from '../../ui/blocks/custom-sandbox';

export interface HostEvent {
  type: string;
  data?: string;
}

export function drainPreviewEvents(page: Page): Promise<HostEvent[]> {
  return page.evaluate(() =>
    (window as unknown as { __tlpPreviewDrain: () => HostEvent[] }).__tlpPreviewDrain(),
  );
}

/** Trusted parent page only. No generated code is ever evaluated in this realm. */
export async function installPreviewHost(
  page: Page,
  shell: string,
  init: ReturnType<typeof buildInit>,
  maxMessageBytes: number,
  height: number,
) {
  await page.setContent(
    '<!doctype html><meta charset="utf-8"><body>' +
      '<button id="activate">Activate block</button><button id="outside">Outside block</button></body>',
  );
  await page.evaluate(
    ({ shell, init, maxMessageBytes, height }) => {
      // No binding is exposed to untrusted frames. Node polls this bounded main-realm
      // queue; the opaque-origin frame cannot reach this function.
      const events: HostEvent[] = [];
      let queuedBytes = 0;
      const send = (event: HostEvent) => {
        events.push(event);
      };
      (window as unknown as { __tlpPreviewDrain: () => HostEvent[] }).__tlpPreviewDrain = () => {
        const batch = events.splice(0);
        queuedBytes = 0;
        return batch;
      };
      const frame = document.createElement('iframe');
      frame.sandbox.add('allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.allow = '';
      frame.inert = true;
      frame.style.cssText = `display:block;width:640px;height:${height}px;border:0`;
      const outside = document.getElementById('outside') as HTMLButtonElement;
      const activate = document.getElementById('activate') as HTMLButtonElement;
      let afterUse = false;
      let active = false;
      let preUseSteals = 0;
      let handBackPending = false;
      const handBacks: number[] = [];
      let failed = false;
      let loads = 0;
      let port: MessagePort | undefined;
      const fail = (reason: string) => {
        if (failed) return;
        failed = true;
        port?.close();
        events.splice(0);
        queuedBytes = 0;
        send({ type: reason });
      };
      const checkFocus = () => {
        if (active || handBackPending || document.activeElement !== frame) return;
        handBackPending = true;
        setTimeout(() => {
          handBackPending = false;
          if (active || document.activeElement !== frame || failed) return;
          if (afterUse) {
            fail('focus_grab_after_use');
            return;
          }
          preUseSteals += 1;
          const now = Date.now();
          handBacks.push(now);
          if (
            preUseSteals > 2 ||
            handBacks.filter((at) => now - at < 1000).length > 5 ||
            handBacks.filter((at) => now - at < 30_000).length > 20
          ) {
            fail('focus_abuse');
            return;
          }
          // Same next-task hand-back as the live host (sync focus return is unreliable).
          outside.focus();
        }, 0);
      };
      document.addEventListener('focusin', checkFocus, true);
      window.addEventListener('blur', () => {
        checkFocus();
        queueMicrotask(checkFocus);
      });
      setInterval(checkFocus, 10);
      activate.addEventListener('click', () => {
        active = true;
        frame.inert = false;
      });
      outside.addEventListener('pointerdown', () => {
        // Arm before blur handlers execute. A synchronous grab-back is a failure too.
        afterUse = true;
        active = false;
        outside.focus();
        frame.inert = true;
        checkFocus();
        if (document.activeElement !== outside) fail('focus_grab_after_use');
      });
      frame.addEventListener('load', () => {
        if (++loads !== 1) {
          fail('navigation');
          return;
        }
        send({ type: 'loaded' });
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessageerror = () => fail('invalid_envelope');
        port.onmessage = (event: MessageEvent<unknown>) => {
          if (failed) return;
          if (typeof event.data !== 'string' || event.data.length > maxMessageBytes) {
            fail('invalid_envelope');
            return;
          }
          // Include per-event overhead: empty-string floods must be bounded too.
          queuedBytes += event.data.length * 2 + 64;
          if (queuedBytes > maxMessageBytes * 4) {
            fail('invalid_envelope');
            return;
          }
          send({ type: 'message', data: event.data });
        };
        frame.contentWindow?.postMessage(init, '*', [channel.port2]);
      });
      // Install all trusted observers before the first untrusted byte can execute.
      frame.srcdoc = shell;
      document.body.append(frame);
    },
    { shell, init, maxMessageBytes, height },
  );
}
