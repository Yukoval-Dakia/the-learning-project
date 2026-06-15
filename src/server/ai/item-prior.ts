// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 输出解析 barrier。
//
// brace-slice + Zod parse（照 question-author.ts:70-89 / quiz_gen parseOutput）。
// Throws on no-JSON / JSON.parse failure / schema mismatch —— backfill job 把
// throw 当作该题本轮跳过（不写 row，下轮重试）。

import { ItemPriorDraft, type ItemPriorDraftT } from '@/core/schema/item_prior';

export function parseItemPriorOutput(text: string): ItemPriorDraftT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseItemPriorOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseItemPriorOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = ItemPriorDraft.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseItemPriorOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}
