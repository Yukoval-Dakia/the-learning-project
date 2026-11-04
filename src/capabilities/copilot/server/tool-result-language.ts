import { inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';

const referenceKey = /^(?:id|ref)$|(?:_ids?|_refs?)$|(?:Id|Ids)$/;
const referenceValue =
  /^(?:[a-z0-9_-]+:[a-z0-9_-]+:[a-z0-9_:-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The trace keeps the original result; only the conversational model sees this view. */
export async function learnerToolResult(db: Db, envelope: Record<string, unknown>) {
  const ids = new Set<string>();
  function collect(value: unknown): void {
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (record(value)) Object.values(value).forEach(collect);
  }
  function references(value: unknown): void {
    if (typeof value === 'string' && referenceValue.test(value)) ids.add(value);
    else if (Array.isArray(value)) value.forEach(references);
    else if (record(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (referenceKey.test(key)) collect(child);
        else references(child);
      }
    }
  }
  references(envelope.output);
  // Resolve only identities already returned by the authorized tool, in one query.
  const rows =
    ids.size > 0
      ? await db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(inArray(knowledge.id, [...ids]))
      : [];
  const names = new Map(rows.map((row) => [row.id, row.name]));
  function label(value: unknown): unknown {
    if (typeof value === 'string') return names.get(value) ?? null;
    if (Array.isArray(value)) return value.map(label);
    return null;
  }
  function display(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((child) =>
        typeof child === 'string' && referenceValue.test(child)
          ? { name: names.get(child) ?? null, refs: { value: child, not_for_display: true } }
          : display(child),
      );
    if (!record(value)) return value;
    const result: Record<string, unknown> = {};
    const refs: Record<string, unknown> = {};
    const labels: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (referenceKey.test(key) || (typeof child === 'string' && referenceValue.test(child))) {
        refs[key] = child;
        const readable = label(child);
        if (
          readable !== null &&
          (!Array.isArray(readable) || readable.some((name) => name !== null))
        )
          labels[key] = readable;
      } else result[key] = display(child);
    }
    return {
      ...result,
      ...(Object.keys(labels).length > 0 ? { reference_labels: labels } : {}),
      ...(Object.keys(refs).length > 0 ? { refs: { ...refs, not_for_display: true } } : {}),
    };
  }
  const { output, ...internal } = envelope;
  return { output: display(output), refs: { ...internal, not_for_display: true } };
}
