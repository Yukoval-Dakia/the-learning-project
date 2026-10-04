import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';

// Pi initializes usage to zero before receiving provider data. Keep the raw
// observation out of transcripts; clones of a message retain its usage object.
const observedUsage = new WeakSet<Usage>();

export function hasPiUsageEvidence(message: AssistantMessage): boolean {
  if (!message.usage) return false;
  return (
    observedUsage.has(message.usage) ||
    [
      message.usage.input,
      message.usage.output,
      message.usage.cacheRead,
      message.usage.cacheWrite,
      message.usage.cost?.total,
    ].some((value) => value !== undefined && value > 0)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasTokenCounts(value: unknown): boolean {
  const usage = record(value);
  return (
    !!usage &&
    ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens'].some(
      (key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]),
    )
  );
}

/** Preserve explicit zero from native provider events without inferring it
 * from a successful stop. Unsupported observers conservatively retain unknown. */
export async function withPiUsageEvidence(
  streamFn: StreamFn,
  ...[model, context, options]: Parameters<StreamFn>
): Promise<Awaited<ReturnType<StreamFn>>> {
  let observed = false;
  const stream = await streamFn(model, context, {
    ...options,
    onProviderStreamEvent: async (data, eventModel) => {
      const event = record(data);
      const nested = record(event?.message) ?? record(event?.response);
      const choices = Array.isArray(event?.choices) ? event.choices : [];
      observed ||=
        hasTokenCounts(event?.usage) ||
        hasTokenCounts(nested?.usage) ||
        choices.some((choice) => hasTokenCounts(record(choice)?.usage));
      await options?.onProviderStreamEvent?.(data, eventModel);
    },
  });
  const mark = (message: AssistantMessage) => {
    if (observed) observedUsage.add(message.usage);
    return message;
  };
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = async function* () {
    const iterator = iterate();
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      const event = next.value;
      if (event.type === 'done') mark(event.message);
      else if (event.type === 'error') mark(event.error);
      yield event;
    }
  };
  const result = stream.result.bind(stream);
  stream.result = async () => mark(await result());
  return stream;
}
