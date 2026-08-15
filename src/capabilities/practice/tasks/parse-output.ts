import type { z } from 'zod';

export function parseTaskOutput<Schema extends z.ZodType>(
  text: string,
  taskKind: string,
  schema: Schema,
): z.output<Schema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${taskKind}: no JSON object found in text`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${taskKind}: JSON.parse failed: ${message}`);
  }
  return schema.parse(json) as z.output<Schema>;
}
