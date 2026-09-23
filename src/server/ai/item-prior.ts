// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 输出解析 barrier。
//
// brace-slice + Zod parse（照 question-author.ts:70-89 / quiz_gen parseOutput）。
// Throws on no-JSON / JSON.parse failure / schema mismatch —— backfill job 把
// throw 当作该题本轮跳过（不写 row，下轮重试）。

import { type LlasaInversion, invertLlasaSimulation } from '@/core/item-prior-llasa';
import {
  ItemPriorDraft,
  type ItemPriorDraftT,
  ItemPriorLlasaDraft,
  type ItemPriorLlasaDraftT,
} from '@/core/schema/item_prior';

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

// ─── YUK-376 — LLaSA 学生模拟变体的解析 barrier ───────────────────────────
//
// 两段式：brace-slice + ItemPriorLlasaDraft Zod parse（模拟作答明细），再走
// src/core/item-prior-llasa.ts 的确定性 1PL MLE 反推折回 ItemPriorDraftT。
// 与上面 parseItemPriorOutput 同样的失败语义——throw 由 backfill job 当该题
// 本轮跳过（不写 row，下轮重试）；覆盖度不足（distinct θ 档 < 4）在 invert
// 侧 throw，同路径处理。

export function parseItemPriorLlasaOutput(text: string): {
  simulation: ItemPriorLlasaDraftT;
  prior: ItemPriorDraftT;
  inversion: LlasaInversion;
} {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseItemPriorLlasaOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseItemPriorLlasaOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = ItemPriorLlasaDraft.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseItemPriorLlasaOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const inversion = invertLlasaSimulation(parsed.data);
  return { simulation: parsed.data, prior: inversion.prior, inversion };
}
