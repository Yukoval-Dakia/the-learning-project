// Seeds the fresh dev database (`pnpm dev:local`) with a few admitted, servable questions so the
// question bank / practice / today pages can be checked without any model call.
//
// Same chokepoints real authoring uses: the question row is inserted like an accepted proposal
// (source 'manual', active), then `publishQuestionGroupFromRow` mints the contract revision and the
// admitted lifecycle (manual provenance, author-reviewed key), and FSRS enrolment goes through
// `enrollFsrsStateIfAbsent`. Every key is a fixed answer, so grading is deterministic
// (exact_option_set / exact_text) and needs no provider.
//
// Idempotent by deterministic ids (`devseed:`); markered with `metadata.dev_seed = true`. Guarded by
// SEED_SYNTHETIC_OK=1 + a loopback DATABASE_URL (assertProdFence) and by requiring the dev database
// name, so TEST's loopback database is refused. `dev:local` runs it on the dev-DB path only.

import './load-env';

import { inArray } from 'drizzle-orm';
import { MARKING_RULE_PROVENANCE, QUESTION_AVAILABILITY } from '@/core/schema/assessment/lifecycle';
import { type Db, type Tx, db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { enrollFsrsStateIfAbsent, initialSchedulingState } from '@/server/fsrs/state';
import { assertProdFence } from './seed-synthetic';

type DbLike = Db | Tx;

const DEV_DATABASE_NAME = 'loom_dev';
const SEED = 'devseed:';
const SUBJECT_DOMAIN = 'math';

const NODES = {
  root: `${SEED}math:root`,
  quadratic: `${SEED}math:quadratic`,
  linear: `${SEED}math:linear-function`,
  probability: `${SEED}math:probability`,
} as const;

const NODE_SPECS = [
  { id: NODES.root, name: '数学（开发种子）', parent: null },
  { id: NODES.quadratic, name: '一元二次方程', parent: NODES.root },
  { id: NODES.linear, name: '一次函数', parent: NODES.root },
  { id: NODES.probability, name: '概率初步', parent: NODES.root },
] as const;

interface SeedQuestion {
  ref: string;
  kind: 'choice' | 'fill_blank';
  node: string;
  prompt_md: string;
  choices_md?: string[];
  reference_md: string;
  difficulty: number;
}

const QUESTIONS: SeedQuestion[] = [
  {
    ref: 'quadratic-roots',
    kind: 'choice',
    node: NODES.quadratic,
    prompt_md: '方程 $x^2 - 5x + 6 = 0$ 的两个根是？',
    choices_md: ['1 和 6', '2 和 3', '-2 和 -3', '-1 和 6'],
    reference_md: 'B',
    difficulty: 2,
  },
  {
    ref: 'quadratic-square',
    kind: 'fill_blank',
    node: NODES.quadratic,
    prompt_md: '方程 $x^2 = 49$ 的正数解是 ____。',
    reference_md: '7',
    difficulty: 1,
  },
  {
    ref: 'quadratic-discriminant',
    kind: 'choice',
    node: NODES.quadratic,
    prompt_md: '一元二次方程 $x^2 + 2x + 1 = 0$ 的根的情况是？',
    choices_md: ['有两个不相等的实数根', '有两个相等的实数根', '没有实数根', '无法确定'],
    reference_md: 'B',
    difficulty: 2,
  },
  {
    ref: 'linear-intercept',
    kind: 'choice',
    node: NODES.linear,
    prompt_md: '一次函数 $y = 2x - 3$ 的图象与 $y$ 轴的交点坐标是？',
    choices_md: ['$(0, -3)$', '$(0, 3)$', '$(\\frac{3}{2}, 0)$', '$(-3, 0)$'],
    reference_md: 'A',
    difficulty: 2,
  },
  {
    ref: 'linear-slope',
    kind: 'fill_blank',
    node: NODES.linear,
    prompt_md: '已知一次函数 $y = kx + 1$ 经过点 $(2, 5)$，则 $k =$ ____。',
    reference_md: '2',
    difficulty: 2,
  },
  {
    ref: 'probability-coin',
    kind: 'choice',
    node: NODES.probability,
    prompt_md: '抛一枚质地均匀的硬币两次，两次都是正面朝上的概率是？',
    choices_md: ['$\\frac{1}{2}$', '$\\frac{1}{3}$', '$\\frac{1}{4}$', '$\\frac{1}{8}$'],
    reference_md: 'C',
    difficulty: 2,
  },
  {
    ref: 'probability-ball',
    kind: 'fill_blank',
    node: NODES.probability,
    prompt_md:
      '袋中有 3 个红球、2 个白球，随机摸出 1 个，摸到红球的概率是 ____（填最简分数，如 1/2）。',
    reference_md: '3/5',
    difficulty: 2,
  },
];

const questionId = (ref: string) => `${SEED}q:${ref}`;

/** Refuse anything but the dev database: loopback alone also matches TEST's database. */
export function assertDevDatabase(env: NodeJS.ProcessEnv = process.env): void {
  assertProdFence(env);
  let name = '';
  try {
    name = new URL(env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    name = '';
  }
  if (name !== DEV_DATABASE_NAME) {
    throw new Error(
      `seed-dev-questions refused: DATABASE_URL must name the dev database "${DEV_DATABASE_NAME}". Got: "${name || '<unset>'}".`,
    );
  }
}

export async function seedDevQuestions(dbh: DbLike, now: Date = new Date()): Promise<number> {
  const present = new Set(
    (
      await dbh
        .select({ id: question.id })
        .from(question)
        .where(
          inArray(
            question.id,
            QUESTIONS.map((q) => questionId(q.ref)),
          ),
        )
    ).map((row) => row.id),
  );
  const pending = QUESTIONS.filter((q) => !present.has(questionId(q.ref)));
  if (pending.length === 0) return 0;

  const enrolled: Array<{ nodeId: string; evidenceEventId: string }> = [];
  await dbh.transaction(async (tx) => {
    // Approved nodes; the root carries the subject domain (domain IS NOT NULL ↔ parent_id IS NULL).
    for (const spec of NODE_SPECS) {
      await tx
        .insert(knowledge)
        .values({
          id: spec.id,
          name: spec.name,
          domain: spec.parent === null ? SUBJECT_DOMAIN : null,
          parent_id: spec.parent,
          approval_status: 'approved',
          proposed_by_ai: false,
          created_at: now,
          updated_at: now,
          version: 0,
        })
        .onConflictDoNothing();
    }
    for (const q of pending) {
      const id = questionId(q.ref);
      await tx.insert(question).values(
        withAnswerClass({
          id,
          kind: q.kind,
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          choices_md: q.choices_md ?? null,
          knowledge_ids: [q.node],
          difficulty: q.difficulty,
          source: 'manual',
          // Fixed key: pin exact comparison so a fill-blank mints a text_key, not a human-review rule.
          judge_kind_override: q.kind === 'fill_blank' ? 'exact' : null,
          draft_status: 'active',
          variant_depth: 0,
          figures: [],
          image_refs: [],
          structured: null,
          created_by: { by: 'user' },
          metadata: { dev_seed: true, seed_ref: q.ref },
          created_at: now,
          updated_at: now,
          version: 0,
        }),
      );
      const published = await publishQuestionGroupFromRow(tx, {
        rootId: id,
        admission: {
          state: 'admitted',
          evidence: {
            marking_provenance: MARKING_RULE_PROVENANCE.MANUAL,
            verification: {
              structural_check_passed: true,
              independent_verification: {
                passed: true,
                verifier: 'human',
                verified_at: now.toISOString(),
              },
              note: 'dev seed: fixed hand-checked answer key',
            },
            model_slice: null,
          },
        },
        availability: QUESTION_AVAILABILITY.GENERAL_POOL,
        claimPolicy: 'unbounded',
        actorRef: 'seed-dev-questions:question',
        now,
      });
      if (published.status !== 'published') {
        throw new Error(`seed-dev-questions: ${id} was not published (${published.status})`);
      }
      enrolled.push({ nodeId: q.node, evidenceEventId: published.event_id });
    }
  });

  const seen = new Set<string>();
  for (const { nodeId, evidenceEventId } of enrolled) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    await enrollFsrsStateIfAbsent(dbh, {
      subject_kind: 'knowledge',
      subject_id: nodeId,
      ...initialSchedulingState(nodeId, now),
      last_review_event_id: evidenceEventId,
    });
  }
  return pending.length;
}

const isEntry =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('seed-dev-questions.ts');
if (isEntry) {
  assertDevDatabase();
  seedDevQuestions(db)
    .then((count) => {
      console.log(
        count > 0
          ? `[seed-dev-questions] seeded ${count} admitted question(s)`
          : '[seed-dev-questions] already seeded, nothing to do',
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed-dev-questions] failed', err);
      process.exit(1);
    });
}
