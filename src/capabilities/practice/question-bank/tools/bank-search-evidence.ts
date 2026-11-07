import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { question_solution_prior } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import type { BankDocument } from './bank-search-contract';
import { bankReadRoleForActor, runReadBank } from './read-bank';

/** Reuse the bank reader's authorization; search never upgrades its caller. */
export async function readBankDocuments(
  db: Db | Tx,
  ctx: Pick<ToolContext, 'callerActor'>,
  refs: string[],
): Promise<BankDocument[]> {
  const documents: BankDocument[] = [];
  for (let start = 0; start < refs.length; start += 80) {
    const batches: string[][] = [];
    for (let i = start; i < Math.min(start + 80, refs.length); i += 20)
      batches.push(refs.slice(i, i + 20));
    const results = await Promise.all(
      batches.map((batch) =>
        runReadBank(
          db,
          {
            refs: batch,
            include: ['content', 'materials', 'answers', 'rubric'],
            extent: { chars: 200000 },
          },
          { role: bankReadRoleForActor(ctx.callerActor), callerRef: ctx.callerActor.ref },
        ),
      ),
    );
    for (const result of results)
      for (const item of result.items) {
        if (item.status !== 'ok' || !item.content) continue;
        const ref = item.ref;
        for (const part of item.content.parts)
          documents.push({
            ref,
            source: `part:${part.part_id}`,
            text: part.prompt_md,
            parts: [part.part_id],
            complete: part.extent?.complete !== false,
            missing: [
              ...(part.extent?.complete === false ? ['part_text_incomplete'] : []),
              ...(/!\[[^\]]*\]\(|<(?:img|svg|video|audio)\b/i.test(part.prompt_md)
                ? ['media_not_read']
                : []),
              ...part.material_ids.flatMap((id) => {
                const material = item.materials?.find((m) => m.material_id === id);
                if (
                  !material ||
                  material.content_md === undefined ||
                  !material.asset.digest_verified
                )
                  return [`missing_or_denied:${id}`];
                if (material.text_extent?.complete === false)
                  return [`material_text_incomplete:${id}`];
                if (
                  ['figure', 'image', 'audio', 'video', 'pdf'].includes(material.kind) ||
                  /!\[[^\]]*\]\(|<(?:img|svg|video|audio)\b/i.test(material.content_md)
                )
                  return [`media_not_read:${id}`];
                return [];
              }),
            ],
          });
        for (const slot of item.content.slots)
          documents.push({
            ref,
            source: `slot:${slot.slot_id}`,
            text: JSON.stringify(slot),
            parts: [slot.part_id],
          });
        for (const material of item.materials ?? [])
          if (
            material.content_md !== undefined &&
            material.asset.digest_verified &&
            material.text_extent?.complete !== false
          )
            documents.push({
              ref,
              source: `material:${material.material_id}`,
              text: material.content_md,
              parts: item.content.parts
                .filter((p) => p.material_ids.includes(material.material_id))
                .map((p) => p.part_id),
            });
        for (const unit of item.answers?.units ?? [])
          documents.push({
            ref,
            source: `criterion:${unit.scoring_unit_id}`,
            text: JSON.stringify(unit.criterion),
            parts: item.content.slots
              .filter((s) => unit.slot_refs.includes(s.slot_id))
              .map((s) => s.part_id),
          });
      }
  }
  if (bankReadRoleForActor(ctx.callerActor) !== 'restricted') {
    const { resolveBankRefs } = await import('./bank-ref');
    const resolved = await resolveBankRefs(db, refs);
    const revs = resolved.flatMap((r) => (r.status === 'ok' ? [r.revision.revision_id] : []));
    const rows = revs.length
      ? await db
          .select()
          .from(question_solution_prior)
          .where(inArray(question_solution_prior.revision_id, revs))
      : [];
    for (const row of rows) {
      const item = resolved.find(
        (r) => r.status === 'ok' && r.revision.revision_id === row.revision_id,
      );
      if (item?.status !== 'ok') continue;
      documents.push({
        ref: item.raw,
        source: `prior:${row.part_id}`,
        text: JSON.stringify(row.prior),
        parts: [row.part_id],
      });
    }
  }
  return documents;
}
