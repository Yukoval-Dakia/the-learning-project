import { eq } from 'drizzle-orm';
import { EMBED_VERSION } from '@/core/embed-source';
import { BACKTRACE_JUDGE_VERSION } from '@/core/schema/backtrace';
import type { Db, Tx } from '@/db/client';
import { attempt_insight_vector } from '@/db/schema';
import { batchResolveAncestorIds } from '@/kernel/read-models/knowledge-tree';
import { backtraceDigest } from './backtrace-input';
import { activeBacktraceEvents, currentInsight } from './backtrace-store';

function cosine(a: number[], b: number[]) {
  const dot = a.reduce((n, x, i) => n + x * b[i], 0);
  return dot / Math.sqrt(a.reduce((n, x) => n + x * x, 0) * b.reduce((n, x) => n + x * x, 0)) || 0;
}
export async function backtracePool(
  db: Db | Tx,
  anchor: NonNullable<Awaited<ReturnType<typeof currentInsight>>>,
) {
  const vectors = await db
    .select()
    .from(attempt_insight_vector)
    .where(eq(attempt_insight_vector.embed_version, EMBED_VERSION));
  const own = vectors.filter((x) => x.insight_event_id === anchor.row.id);
  const candidates = [];
  const seen = new Set<string>();
  for (const raw of await activeBacktraceEvents(db, 'experimental:attempt_insight')) {
    if (raw.subject_id === anchor.row.subject_id || seen.has(raw.subject_id)) continue;
    seen.add(raw.subject_id);
    const current = await currentInsight(db, raw.subject_id);
    if (!current?.basis.visible || current.basis.input.created_at >= anchor.basis.input.created_at)
      continue;
    const other = vectors.filter((x) => x.insight_event_id === current.row.id);
    const scores = { mechanism: 0, method: 0, needed_method: 0 };
    for (const a of own)
      for (const b of other) {
        if (a.facet === 'mechanism' && b.facet === 'mechanism')
          scores.mechanism = Math.max(scores.mechanism, cosine(a.embedding, b.embedding));
        if ((a.facet === 'method' || a.facet === 'needed_method') && b.facet === 'method')
          scores[a.facet] = Math.max(scores[a.facet], cosine(a.embedding, b.embedding));
      }
    candidates.push({ ...current, scores, sim: Math.max(...Object.values(scores)) });
  }
  const grouped = new Map<string, (typeof candidates)[number]>();
  for (const item of candidates) {
    const evidence = item.basis.input;
    const key = backtraceDigest({
      question: evidence.question_id,
      answer: evidence.answer_md.normalize('NFKC'),
      trace: evidence.reasoning_trace.normalize('NFKC'),
      response: evidence.response_set,
    });
    if (!grouped.has(key)) grouped.set(key, item);
  }
  const unique = [...grouped.values()];
  const same = unique
    .filter((x) => x.insight.question_id === anchor.insight.question_id)
    .slice(0, 5);
  const mechanism = unique
    .filter((x) => x.insight.mechanism !== null)
    .sort((a, b) => b.scores.mechanism - a.scores.mechanism)
    .slice(0, 12);
  const methods = unique.filter(
    (x) =>
      x.insight.method?.provenance === 'evidence' && x.insight.verdict_seen.outcome === 'success',
  );
  const used = [...methods].sort((a, b) => b.scores.method - a.scores.method).slice(0, 8);
  const needed = [...methods]
    .sort((a, b) => b.scores.needed_method - a.scores.needed_method)
    .slice(0, 8);
  const knowledgeIds = [
    ...new Set([anchor, ...unique].flatMap((x) => x.basis.input.referenced_knowledge_ids)),
  ];
  const ancestors = await batchResolveAncestorIds(db, knowledgeIds);
  const expand = (ids: string[]) =>
    new Set(ids.flatMap((id) => [id, ...(ancestors.get(id) ?? [])]));
  const anchorKnowledge = expand(anchor.basis.input.referenced_knowledge_ids);
  const neighbours = unique
    .filter((x) =>
      [...expand(x.basis.input.referenced_knowledge_ids)].some((id) => anchorKnowledge.has(id)),
    )
    .slice(0, 6);
  const retrieved = [
    ...new Map(
      [...mechanism, ...used, ...needed, ...neighbours].map((x) => [x.row.id, x]),
    ).values(),
  ].sort((a, b) => b.sim - a.sim);
  const union = [...new Map([...same, ...retrieved].map((x) => [x.row.id, x])).values()].slice(
    0,
    16,
  );
  const pool = union.map((x) => ({
    attempt_event_id: x.row.subject_id,
    insight_event_id: x.row.id,
    insight: {
      ...x.insight,
      method: x.insight.method?.provenance === 'evidence' ? x.insight.method : null,
    },
    answer_md: x.basis.input.answer_md,
    prompt_md: x.basis.input.prompt_md?.slice(0, 200) ?? null,
    created_at: x.basis.input.created_at,
    outcome: x.basis.input.outcome,
    sim: x.sim,
  }));
  return {
    pool,
    digest: backtraceDigest({ version: BACKTRACE_JUDGE_VERSION, anchor: anchor.row.id, pool }),
  };
}
