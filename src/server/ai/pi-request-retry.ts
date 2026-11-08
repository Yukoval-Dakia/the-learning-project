// Resend ONE interrupted provider request inside the agent loop. The loop sees
// a single assistant response: the dead attempt's events are already out, so the
// wrapper yields one marker event (registered in `requestRetryMarkers`) before
// the resend, and whoever forwarded the dead attempt's deltas must retract them
// on that marker. Tools never rerun — they execute only after a response
// completes, and the resend carries the same context, executed results included.

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { ProviderRequestInterruption } from '@/ai/provider-failure';
import type { InterruptedRequestRetryBound } from './provider-transient-retry';
import { sleepMs } from './provider-transient-retry';

export interface RequestRetryNotice {
  /** 1-based resend number. */
  readonly retry: number;
  readonly maxRetries: number;
  readonly reason: ProviderRequestInterruption;
  readonly delayMs: number;
}

/**
 * Marker events the wrapper emits in-band. The agent loop forwards stream events
 * by identity (`message_update.assistantMessageEvent`), so the marker stays
 * ordered after every delta of the attempt it retracts.
 */
export const requestRetryMarkers = new WeakMap<object, RequestRetryNotice>();

export function retryInterruptedRequest(
  open: StreamFn,
  deps: {
    bound: InterruptedRequestRetryBound;
    /** Decides from the dead attempt's evidence; undefined keeps the failure. */
    interruption: (failed: PiAssistantMessage) => ProviderRequestInterruption | undefined;
    /** Clear per-request failure state before the resend opens. */
    beforeResend: () => void;
    signal: AbortSignal;
  },
): StreamFn {
  return async (model, context, options) => {
    const first = await open(model, context, options);
    let settle!: (message: PiAssistantMessage) => void;
    let reject!: (error: unknown) => void;
    const final = new Promise<PiAssistantMessage>((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
    final.catch(() => {});
    let current = {
      events: first[Symbol.asyncIterator].bind(first),
      result: first.result.bind(first),
    };
    first[Symbol.asyncIterator] = async function* () {
      let started = false;
      let partial: PiAssistantMessage | undefined;
      try {
        for (let retry = 0; ; retry += 1) {
          let terminal: PiAssistantMessageEvent | undefined;
          for await (const event of { [Symbol.asyncIterator]: current.events }) {
            if (event.type === 'done' || event.type === 'error') {
              terminal = event;
              break;
            }
            if (event.type === 'start') {
              // The loop already holds this response's partial message slot.
              partial = event.partial;
              if (started) continue;
              started = true;
            } else if ('partial' in event) {
              partial = event.partial;
            }
            yield event;
          }
          const message = await current.result();
          const reason =
            message.stopReason === 'error' && retry < deps.bound.maxRetries && !deps.signal.aborted
              ? deps.interruption(message)
              : undefined;
          if (reason === undefined) {
            settle(message);
            if (terminal) yield terminal;
            return;
          }
          const notice: RequestRetryNotice = {
            retry: retry + 1,
            maxRetries: deps.bound.maxRetries,
            reason,
            delayMs: deps.bound.baseDelayMs * 2 ** retry,
          };
          const { errorMessage: _dead, ...template } = partial ?? message;
          const empty: PiAssistantMessage = { ...template, content: [], stopReason: 'stop' };
          if (!started) {
            // The loop drops updates before a start; open the slot so the
            // marker (and its reconnecting state) reaches the consumer now.
            started = true;
            yield { type: 'start', partial: empty };
          }
          // The empty partial also clears the dead attempt's content from the
          // loop's context slot until the resend's first delta replaces it.
          const marker: PiAssistantMessageEvent = {
            type: 'text_end',
            contentIndex: 0,
            content: '',
            partial: empty,
          };
          requestRetryMarkers.set(marker, notice);
          yield marker;
          try {
            await sleepMs(notice.delayMs, deps.signal);
          } catch {
            settle(message);
            if (terminal) yield terminal;
            return;
          }
          deps.beforeResend();
          const next = await open(model, context, options);
          current = {
            events: next[Symbol.asyncIterator].bind(next),
            result: next.result.bind(next),
          };
        }
      } catch (error) {
        reject(error);
        throw error;
      }
    };
    first.result = () => final;
    return first;
  };
}
