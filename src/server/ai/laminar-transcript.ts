import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { z } from 'zod';

type TraceValue = null | boolean | number | string | TraceValue[] | { [key: string]: TraceValue };
export const TRANSCRIPT_MAX_SERIALIZED_CHARS = 65536;
const TEXT_LIMIT = 8000;
const ENTRY_LIMIT = 64;
const TRUNCATED = '[TRUNCATED: transcript limit]';
const privateKey =
  /^(?:api[-_]?key|key[-_]?auth|auth(?:orization|entication|headers)?|.*credential.*|.*password.*|.*secret.*|(?:access|refresh|id|api|auth|oauth)?[-_]?token|cookie|set[-_]?cookie|headers|requestHeaders|env|environment|processEnv|bindings?|providerBindings?|modelBindings?|privateKey|signingKey|rawCot|cotContent|rawThinking|thinking|thinkingSignature|reasoning|reasoningContent|rawReasoning|chainOfThought|cot|textSignature|base64|binary)$/i;

export function developmentTranscriptsEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.LMNR_DEV_TRANSCRIPTS === '1';
}

/** Only known secret syntax is removed. Ordinary educational prose stays visible. */
function cleanText(value: string): string {
  const prefix = value.slice(0, TEXT_LIMIT);
  const cleaned = prefix
    .replace(
      /<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      '[omitted: reasoning]',
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[omitted: private key]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[omitted: authorization]')
    .replace(
      /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[omitted: credential]',
    )
    .replace(
      /\b(api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token|authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)(?:\s+[^\s,;]+)?/gi,
      '$1=[omitted: credential]',
    )
    .replace(/(?:https?:\/\/)[^\s<>"'；]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return parsed.search || parsed.username || parsed.password
          ? '[omitted: signed or credential URL]'
          : url;
      } catch {
        return '[omitted: invalid URL]';
      }
    })
    .replace(/\bdata:[^\s"']+/gi, '[omitted: data URI]')
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, '[omitted: binary/base64]');
  return cleaned + (value.length > TEXT_LIMIT ? TRUNCATED : '');
}

/** Traverse data descriptors only; never invoke getters, toJSON, or fetch assets. */
export function sanitizeTracePayload(value: unknown): TraceValue {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let remaining = 24000;
  const text = (raw: string): string => {
    if (remaining <= 0) return TRUNCATED;
    const cleaned = cleanText(raw);
    const result = cleaned.slice(0, remaining);
    remaining -= result.length;
    return result + (result.length < cleaned.length ? TRUNCATED : '');
  };
  const visit = (item: unknown, depth: number): TraceValue => {
    if (++nodes > 1000 || depth > 8 || remaining <= 0) return TRUNCATED;
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number')
      return Number.isFinite(item) ? item : '[omitted: nonfinite number]';
    if (typeof item === 'bigint') return text(String(item));
    if (typeof item === 'string') {
      // Tools often return structured JSON in text blocks. Remove nested private fields too.
      if (/^\s*[[{]/.test(item)) {
        if (item.length > TRANSCRIPT_MAX_SERIALIZED_CHARS)
          return '[TRUNCATED: structured text exceeds parsing limit]';
        try {
          return JSON.stringify(visit(JSON.parse(item), depth + 1));
        } catch {
          /* Plain prose. */
        }
      }
      return text(item);
    }
    if (typeof item !== 'object') return '[omitted: non-JSON value]';
    if (item instanceof Error) return '[omitted: error object]';
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return '[omitted: binary]';
    if (ancestors.has(item)) return '[omitted: circular]';
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const values: TraceValue[] = [];
        for (let index = 0; index < Math.min(item.length, ENTRY_LIMIT); index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          values.push(
            descriptor && 'value' in descriptor
              ? visit(descriptor.value, depth + 1)
              : '[omitted: accessor]',
          );
        }
        if (item.length > ENTRY_LIMIT) values.push(TRUNCATED);
        return values;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return '[omitted: non-JSON object]';
      const type = Object.getOwnPropertyDescriptor(item, 'type')?.value;
      const mime = Object.getOwnPropertyDescriptor(item, 'mimeType')?.value;
      if (typeof mime === 'string' && /^(?:image|audio|video)\//i.test(mime))
        return '[omitted: binary media]';
      if (
        typeof type === 'string' &&
        /^(?:image|image_url|input_image|audio|file|thinking|reasoning|redacted_thinking)$/i.test(
          type,
        )
      )
        return '[omitted: image/binary/reasoning block]';
      const entries: [string, TraceValue][] = [];
      let count = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (count++ >= ENTRY_LIMIT) {
          entries.push(['_truncation', TRUNCATED]);
          break;
        }
        if (privateKey.test(key.replace(/[-_\s]/g, '')) || key === 'toJSON') continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        const safeKey = text(key).slice(0, 100);
        entries.push([
          safeKey,
          descriptor && 'value' in descriptor
            ? visit(descriptor.value, depth + 1)
            : '[omitted: accessor]',
        ]);
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(item);
    }
  };
  try {
    const result = visit(value, 0);
    return JSON.stringify(result).length <= TRANSCRIPT_MAX_SERIALIZED_CHARS ? result : TRUNCATED;
  } catch {
    return '[omitted: unserializable payload]';
  }
}

const transcriptMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});

/** Keep truncation in a supported message shape so the transcript remains readable. */
export function sanitizeTraceMessages(value: unknown): TraceValue {
  const sanitized = sanitizeTracePayload(value);
  const messages: z.infer<typeof transcriptMessageSchema>[] = [];
  let omitted = !Array.isArray(sanitized);
  if (Array.isArray(sanitized))
    for (const message of sanitized) {
      const parsed = transcriptMessageSchema.safeParse(message);
      if (parsed.success) messages.push(parsed.data);
      else omitted = true;
    }
  if (omitted || messages.length === 0) messages.push({ role: 'system', content: TRUNCATED });
  return JSON.stringify(messages).length <= TRANSCRIPT_MAX_SERIALIZED_CHARS
    ? messages
    : [{ role: 'system', content: TRUNCATED }];
}

function visibleContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  const text =
    content
      .slice(0, ENTRY_LIMIT)
      .map((block) => {
        switch (block.type) {
          case 'text': {
            const safe = sanitizeTracePayload(block.text);
            return typeof safe === 'string' ? safe : JSON.stringify(safe);
          }
          case 'image':
            return '[omitted: image]';
          case 'thinking':
            return '';
          case 'toolCall':
            return '';
          default: {
            const exhaustive: never = block;
            return exhaustive;
          }
        }
      })
      .join('\n') + (content.length > ENTRY_LIMIT ? TRUNCATED : '');
  return cleanText(text);
}

function assistantTranscript(message: AssistantMessage) {
  return {
    role: 'assistant',
    content: visibleContent(message.content),
    ...(message.responseId ? { id: message.responseId } : {}),
    tool_calls: message.content
      .slice(0, ENTRY_LIMIT)
      .filter((block) => block.type === 'toolCall')
      .slice(0, ENTRY_LIMIT)
      .map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(sanitizeTracePayload(call.arguments)),
        },
      })),
  };
}

/** OpenAI-style message arrays supported by Laminar's LLM transcript renderer. */
export function piInputTranscript(messages: Message[]): unknown {
  const result = messages.slice(0, ENTRY_LIMIT).map((message) => {
    switch (message.role) {
      case 'assistant':
        return assistantTranscript(message);
      case 'system':
        return {
          role: 'system',
          content: [
            visibleContent(message.content),
            ...Object.values(message.sections ?? {})
              .slice(0, ENTRY_LIMIT)
              .filter((section) => typeof section === 'string'),
          ].join('\n'),
        };
      case 'user':
        return { role: 'user', content: visibleContent(message.content) };
      case 'toolResult':
        return {
          role: 'tool',
          name: message.toolName,
          tool_call_id: message.toolCallId,
          content: visibleContent(message.content),
        };
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  });
  if (messages.length > ENTRY_LIMIT) result.push({ role: 'system', content: TRUNCATED });
  return result;
}

export function piOutputTranscript(message: AssistantMessage): unknown {
  return [assistantTranscript(message)];
}
