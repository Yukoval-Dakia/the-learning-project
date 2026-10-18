// 一次性重封：内容没改、但库存摘要是调用方键序，读方按 jsonb 键序对不上的 revision。
//
// 读方仍然只认三份从存库层重算的封印（规范、schema 键序、存库 jsonb 键序）。
// 故意改过的层重算不出原来的摘要，脚本留下不写，准入继续 stale。
// 已经对得上的旧规范 / 旧 schema 封印不改，题库 ref 前缀保持原样。
//
// 会改写的行：question_revision.integrity_digest 换成规范封印。
// 不改写核验历史、发布事件。已发出的 qrev1 ref 前缀会失效，要按新摘要重取。
// 队列里钉着旧摘要的准入作业会 stale，重封之后需要重新入队，本脚本不入队。
//
//   pnpm exec tsx scripts/reseal-admission-digest.ts --self-check
//   pnpm exec tsx scripts/reseal-admission-digest.ts              # 只报告
//   pnpm exec tsx scripts/reseal-admission-digest.ts --apply      # 写入

import './load-env';

import { and, eq } from 'drizzle-orm';
import { question_revision } from '@/db/schema';
import {
  classifyStoredRevisionDigest,
  layersOfStoredRevision,
  resealDecision,
} from '@/kernel/records/admission-digest-reseal';
import {
  contractIntegrityDigest,
  publishedContractSeal,
  publishedSealAccepts,
} from '@/kernel/records/assessment-normalization';

const APPLY = process.argv.includes('--apply');
const SELF_CHECK = process.argv.includes('--self-check');

function rejectUnknownArgs(): void {
  for (const arg of process.argv.slice(2)) {
    if (arg !== '--apply' && arg !== '--self-check') throw new Error(`unknown argument: ${arg}`);
  }
}

function reorderJsonb<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reorderJsonb(item)) as T;
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(
    (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
  );
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = reorderJsonb(record[key]);
  return out as T;
}

function minimalLayers() {
  return publishedContractSeal({
    structure: {
      group_id: 'g1',
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: '水的化学式', material_ids: [] }],
    },
    response_spec: {
      slots: [{ slot_id: 's1', part_id: 'p1', kind: 'text', math_preview: false }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u1',
          slot_refs: ['s1'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: ['H2O'], normalization: 'trim' },
          points: 1,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        { scoring_unit_ids: ['u1'], executor: { kind: 'deterministic', comparator: 'exact_text' } },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
  }).parsed;
}

function assertCase(name: string, ok: boolean): void {
  if (!ok) throw new Error(`self-check failed: ${name}`);
}

function runSelfCheck(): void {
  const parsed = minimalLayers();
  const caller = {
    structure: parsed.structure,
    response_spec: reorderJsonb(parsed.response_spec),
    scoring_basis: reorderJsonb(parsed.scoring_basis),
    execution_plan: reorderJsonb(parsed.execution_plan),
  };
  const supplied = contractIntegrityDigest(caller);
  const stored = reorderJsonb(caller) as typeof caller;
  const storedSeal = publishedContractSeal(stored);
  const canonical = publishedContractSeal(caller).canonical;

  assertCase(
    'three stored seals differ',
    new Set([storedSeal.canonical, storedSeal.legacyParsed, storedSeal.legacyRaw]).size === 3,
  );
  assertCase(
    'writer accepts caller seal',
    publishedSealAccepts(publishedContractSeal(caller), supplied),
  );
  assertCase(
    'reader rejects caller seal after jsonb reorder',
    !publishedSealAccepts(storedSeal, supplied),
  );
  assertCase(
    'reader accepts canonical stored by the writer',
    publishedSealAccepts(storedSeal, canonical),
  );
  assertCase(
    'caller-order row is resealable',
    resealDecision(classifyStoredRevisionDigest(stored, supplied)).action === 'rewrite',
  );

  const tampered = structuredClone(stored);
  tampered.structure.parts[0].prompt_md = '被改过的题干';
  const tamperedSeal = publishedContractSeal(tampered);
  assertCase(
    'tampered caller-order row stays stale',
    !publishedSealAccepts(tamperedSeal, supplied),
  );
  assertCase(
    'tamper is not rewritten to a fresh canonical',
    resealDecision(classifyStoredRevisionDigest(tampered, supplied)).action === 'leave_stale',
  );
  assertCase(
    'tamper does not match the old schema seal',
    !publishedSealAccepts(tamperedSeal, storedSeal.legacyParsed),
  );
  assertCase(
    'tamper does not match the old canonical seal',
    !publishedSealAccepts(tamperedSeal, storedSeal.canonical),
  );
  assertCase(
    'untampered schema seal still verifies',
    publishedSealAccepts(storedSeal, storedSeal.legacyParsed) &&
      resealDecision(classifyStoredRevisionDigest(stored, storedSeal.legacyParsed)).action ===
        'keep',
  );
  assertCase(
    'untampered canonical seal is kept',
    resealDecision(classifyStoredRevisionDigest(stored, storedSeal.canonical)).action === 'keep',
  );

  const placed = structuredClone(parsed);
  placed.response_spec.slots[0].placement = { row: 0, col: 1, label: '(1)' };
  const placedDigest = contractIntegrityDigest(placed);
  const placedStored = reorderJsonb(placed);
  assertCase(
    'placement appended after build reseals',
    resealDecision(classifyStoredRevisionDigest(placedStored, placedDigest)).action === 'rewrite',
  );
  assertCase(
    'placement caller seal does not verify from jsonb order',
    !publishedSealAccepts(publishedContractSeal(placedStored), placedDigest),
  );

  const injected = structuredClone(parsed) as typeof parsed & {
    structure: typeof parsed.structure & { qa_injected?: boolean };
  };
  injected.structure = { ...parsed.structure, qa_injected: true };
  const injectedDigest = contractIntegrityDigest(injected);
  const injectedStored = reorderJsonb(injected);
  assertCase(
    'unknown key appended after build reseals',
    resealDecision(classifyStoredRevisionDigest(injectedStored, injectedDigest)).action ===
      'rewrite',
  );
  const injectedTamper = structuredClone(injectedStored) as typeof injected;
  injectedTamper.structure.qa_injected = false;
  assertCase(
    'flipping an unknown key stays stale',
    resealDecision(classifyStoredRevisionDigest(injectedTamper, injectedDigest)).action ===
      'leave_stale',
  );

  const author = {
    structure: parsed.structure,
    response_spec: {
      ...parsed.response_spec,
      slots: [reorderJsonb(parsed.response_spec.slots[0])],
    },
    scoring_basis: {
      ...parsed.scoring_basis,
      units: [reorderJsonb(parsed.scoring_basis.units[0])],
    },
    execution_plan: {
      ...parsed.execution_plan,
      assignments: [reorderJsonb(parsed.execution_plan.assignments[0])],
    },
  };
  const authorDigest = contractIntegrityDigest(author);
  const authorStored = reorderJsonb(author);
  assertCase(
    'author splice of one stored unit reseals',
    resealDecision(classifyStoredRevisionDigest(authorStored, authorDigest)).action === 'rewrite',
  );

  console.log(
    JSON.stringify({
      self_check: 'pass',
      caller_seal_verifies_after_reorder: false,
      canonical_verifies_after_reorder: true,
      tamper_stays_stale: true,
      legacy_schema_kept: true,
    }),
  );
}

async function reportDatabase(): Promise<void> {
  const { db } = await import('@/db/client');
  const rows = await db
    .select({
      revision_id: question_revision.revision_id,
      group_id: question_revision.group_id,
      integrity_digest: question_revision.integrity_digest,
      structure: question_revision.structure,
      response_spec: question_revision.response_spec,
      scoring_basis: question_revision.scoring_basis,
      execution_plan: question_revision.execution_plan,
      presentation: question_revision.presentation,
    })
    .from(question_revision);

  const counts = { keep: 0, rewrite: 0, leave_stale: 0 };
  const rewrite: { revision_id: string; group_id: string; from: string; to: string }[] = [];
  const stale: { revision_id: string; group_id: string }[] = [];
  for (const row of rows) {
    const decision = resealDecision(
      classifyStoredRevisionDigest(layersOfStoredRevision(row), row.integrity_digest),
    );
    counts[decision.action] += 1;
    if (decision.action === 'rewrite') {
      rewrite.push({
        revision_id: row.revision_id,
        group_id: row.group_id,
        from: row.integrity_digest,
        to: decision.canonical,
      });
    } else if (decision.action === 'leave_stale') {
      stale.push({ revision_id: row.revision_id, group_id: row.group_id });
    }
  }

  let updated = 0;
  if (APPLY && rewrite.length > 0) {
    updated = await db.transaction(async (tx) => {
      let wrote = 0;
      for (const row of rewrite) {
        const changed = await tx
          .update(question_revision)
          .set({ integrity_digest: row.to })
          .where(
            and(
              eq(question_revision.revision_id, row.revision_id),
              eq(question_revision.integrity_digest, row.from),
            ),
          )
          .returning({ revision_id: question_revision.revision_id });
        wrote += changed.length;
      }
      return wrote;
    });
  }

  console.log(
    JSON.stringify({
      mode: APPLY ? 'apply' : 'dry_run',
      revisions: rows.length,
      keep: counts.keep,
      rewrite: counts.rewrite,
      leave_stale: counts.leave_stale,
      updated,
      rewrite_rows: rewrite,
      stale,
    }),
  );
}

rejectUnknownArgs();
if (SELF_CHECK) {
  runSelfCheck();
} else {
  reportDatabase().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
