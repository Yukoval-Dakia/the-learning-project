import type { z } from 'zod';
import type { TaskTextResult } from '@/server/ai/provenance';

/** Parse balanced JSON objects while recovering after malformed prose candidates. */
export function jsonObjectCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }

    if (end < 0) {
      cursor = start + 1;
      continue;
    }
    try {
      candidates.push(JSON.parse(text.slice(start, end + 1)));
      cursor = end + 1;
    } catch {
      // Retry from the next opening brace; the failed span may wrap valid JSON.
      cursor = start + 1;
    }
  }
  return candidates;
}

/**
 * Prefer Agent SDK structured_output, then balanced JSON text. The model-facing
 * envelope keeps the SDK input_schema object-root compatible; direct parsing remains
 * for historical run replay.
 */
export function parseTaskStructuredOutput<T>(
  result: TaskTextResult,
  schema: z.ZodType<T>,
  envelopeKey: string,
): T | null {
  const candidates = [result.structured_output, ...jsonObjectCandidates(result.text)].filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  for (const candidate of candidates) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      envelopeKey in candidate
    ) {
      const wrapped = schema.safeParse((candidate as Record<string, unknown>)[envelopeKey]);
      if (wrapped.success) return wrapped.data;
    }
    const direct = schema.safeParse(candidate);
    if (direct.success) return direct.data;
  }
  return null;
}
