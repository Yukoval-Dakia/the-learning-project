/** Synthetic, owned dev corpus. Never resets a database or reads learner content. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { SolutionPriorPart } from '@/capabilities/practice/question-bank/server/admission/solution-prior';
import { solutionPriorFacetTexts } from '@/capabilities/practice/question-bank/server/admission/solution-prior-vectors';
import { encodeBankRef } from '@/capabilities/practice/question-bank/tools/bank-ref';
import { EMBED_VERSION, embedHash, questionEmbedText } from '@/core/embed-source';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/kernel/records/assessment-normalization';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { EMBED_MODEL, embedMany } from '@/server/ai/embed';
import {
  assertSearchBenchmarkPaidGate,
  guardSearchBenchmarkEmbedding,
} from './search-bank-paid-gate';

const families = [
  '一元二次方程求解',
  '一元二次方程判别式',
  '一元二次方程配方法',
  '一次函数代入',
  '一次函数增减性',
  '单骰概率',
  '双骰概率',
  '等差数列',
  '等比数列',
  '三角形面积',
  '三角函数',
  '导数',
];
function content(i: number) {
  const a = 2 + (i % 11),
    b = 1 + (i % 7),
    n = 2 + (i % 4);
  const rows = [
    [
      `解一元二次方程 x²-${a + b}x+${a * b}=0，两个根是什么？`,
      `${a}和${b}`,
      '因式分解',
      `(x-${a})(x-${b})=0`,
    ],
    [
      `关于x的一元二次方程 x²-${2 * a}x+${a * a - b}=0，用判别式判断实根个数。`,
      '两个不相等实根',
      '判别式',
      `Δ=${4 * b}>0`,
    ],
    [`解一元二次方程 x²-${2 * a}x+${a * a - b}=0。`, `${a}±√${b}`, '配方法', `(x-${a})²=${b}`],
    [`一次函数 y=${a}x+${b}，当x=2时，y等于多少？`, `${2 * a + b}`, '代入求值', `y=${a}×2+${b}`],
    [`一次函数 y=-${a}x+${b}，x增大时y怎样变化？`, '减小', '一次函数性质', `斜率-${a}<0`],
    [
      `掷一枚均匀六面骰子，点数大于${n}的概率是多少？`,
      `${6 - n}/6`,
      '古典概型',
      `有利点数${6 - n}个，等可能点数6个`,
    ],
    [
      `同时掷两枚均匀六面骰子，点数和为${n + 3}的概率是多少？`,
      `${n + 2}/36`,
      '枚举有序结果',
      `点数和${n + 3}有${n + 2}个有序结果，共36种`,
    ],
    [`等差数列首项${a}、公差${b}，第5项是多少？`, `${a + 4 * b}`, '等差数列通项', `a₅=${a}+4×${b}`],
    [`等比数列首项${a}、公比${n}，第4项是多少？`, `${a * n ** 3}`, '等比数列通项', `a₄=${a}×${n}³`],
    [
      `三角形底${2 * a}厘米，对应高${b}厘米，面积多少平方厘米？`,
      `${a * b}`,
      '面积公式',
      `S=${2 * a}×${b}/2`,
    ],
    [`利用单位圆，求三角函数 sin30° 的值。样本编号${i}。`, '1/2', '单位圆', '30°对应纵坐标为1/2'],
    [
      `函数 f(x)=x^${n}，求导数 f′(x)。`,
      `${n}x^${n - 1}`,
      '幂函数求导',
      `(x^${n})′=${n}x^${n - 1}`,
    ],
  ];
  const [prompt, answer, method, step] = rows[i % rows.length];
  return { prompt, answer, method, step };
}
type CorpusRow = { id: string; family: number; ref: string | null; text: string };
function writeGoldProposal(output: string, corpus: CorpusRow[]) {
  const rows = corpus.slice(0, 101);
  const ref = (i: number) => {
    const value = rows[i].ref;
    if (!value) throw Error('Published fixture ref missing');
    return value;
  };
  const prompts = [
    '给我找两道一元二次方程的题',
    '我想练一次函数，有简单点的题吗',
    '概率有没有掷骰子的题',
    '来一道一元二次方程判别式的题',
    '帮我找道一次函数的题做做',
    '给我找一道参考解用配方法的一元二次方程题',
    '圆锥曲线有没有考离心率的题',
    '有没有二次函数顶点式的题',
    '再找一道和刚才那道判别式题同类的题',
    '找一道我做错过的一次函数题',
    '找两道一元二次方程题，别给我刚才那道了',
    '找一道没做过的一次函数题',
  ];
  const familiesByRequest = [
    [0, 1, 2],
    [3, 4],
    [5, 6],
    [1],
    [3, 4],
    [2],
    [],
    [],
    [1],
    [3],
    [0, 1, 2],
    [3, 4],
  ];
  const requests = prompts.map((query, i) => ({
    query,
    provenance:
      i < 5
        ? 'frozen protocol'
        : i === 5
          ? 'explicit method sample'
          : 'writer synthetic supplement; not a historical learner log',
    input:
      i === 8
        ? { like_ref: ref(1) }
        : i === 9
          ? { filters: { history: 'wrong' } }
          : i === 10
            ? { filters: { exclude_refs: [ref(0)] } }
            : i === 11
              ? { filters: { history: 'unseen' } }
              : undefined,
    easy_ids: i === 1 ? rows.filter((q) => q.family === 4).map((q) => q.id) : undefined,
    template_family_ids: familiesByRequest[i],
    relevant_ids: rows
      .filter(
        (q) =>
          familiesByRequest[i].includes(q.family) &&
          (i !== 9 || q.id === 'sb1986:003') &&
          (i !== 10 || q.id !== rows[0].id) &&
          (i !== 11 || !['sb1986:000', 'sb1986:001', 'sb1986:003'].includes(q.id)),
      )
      .map((q) => q.id),
    corpus_absent: familiesByRequest[i].length === 0,
  }));
  writeFileSync(
    join(output, 'golden-proposed.json'),
    JSON.stringify(
      {
        label_tier: 'lead_judged_synthetic',
        judged_by: 'coordinating lead, 2026-11-07 instruction',
        definitions: {
          easy: 'lower half within theme by authored difficulty; preference when missing',
          same_type:
            'same KC and assessment point; numerical template variants separately reported',
        },
        human_marked_by: null,
        human_approved_at: null,
        status: 'LEAD_JUDGED_SYNTHETIC_NOT_REAL_HUMAN_GOLD',
        corpus: 'corpus-own-synthetic.json',
        requests,
        real_human_gold_complete: false,
        missing_real_utterances: ['migration line historical learner requests not yet supplied'],
      },
      null,
      2,
    ),
  );
}
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw Error('DATABASE_URL required');
  const target = new URL(url);
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.port !== '5434' ||
    !target.pathname.startsWith('/loom_dev_')
  )
    throw Error('Only a new owned local dev database may be seeded');
  const output = process.env.SEARCH_BENCH_OUTPUT;
  if (!output) throw Error('External SEARCH_BENCH_OUTPUT required');
  mkdirSync(output, { recursive: true });
  const client = postgres(url, { max: 5 });
  const db = drizzle(client, { schema }) as Db;
  try {
    const existing = await db.select({ id: schema.question.id }).from(schema.question);
    if (existing.some((q) => !q.id.startsWith('sb1986:')))
      throw Error('Refusing to alter another corpus');
    if (process.argv.includes('--prepare-gold')) {
      if (existing.length !== 475) throw Error('Complete owned fixture required');
      const corpus = JSON.parse(
        readFileSync(join(output, 'corpus-own-synthetic.json'), 'utf8'),
      ) as CorpusRow[];
      for (const i of [0, 1, 3])
        await db
          .insert(schema.event)
          .values({
            id: `sb1986:history:${i}`,
            actor_kind: 'user',
            actor_ref: 'synthetic-search-fixture',
            action: 'attempt',
            subject_kind: 'question',
            subject_id: `sb1986:${String(i).padStart(3, '0')}`,
            outcome: i === 1 ? 'success' : 'failure',
            payload: { answer: 'synthetic fixture only' },
            created_at: new Date(),
          })
          .onConflictDoNothing();
      const servable = await readAutomaticallyServableQuestionIds(
        db,
        corpus.slice(0, 101).map((q) => q.id),
      );
      if (servable.size !== 101)
        throw Error(`Fixture is not usable: ${servable.size}/101 servable`);
      writeGoldProposal(output, corpus);
      console.log('Prepared synthetic history and proposed labels; NOT human-approved gold');
      return;
    }
    const fillOnly = process.argv.includes('--fill-vectors');
    if (existing.length && !fillOnly)
      throw Error(
        'Fixture already exists; use --fill-vectors for this owned corpus, never silently reseed',
      );
    if (fillOnly && existing.length !== 475)
      throw Error('Expected the complete owned fixture before vector filling');
    if (!fillOnly) {
      const now = new Date();
      const [root] = await db
        .select()
        .from(schema.knowledge)
        .where(eq(schema.knowledge.domain, 'math'))
        .limit(1);
      const rootId = root?.id ?? 'sb1986:math';
      if (!root)
        await db.insert(schema.knowledge).values({
          id: rootId,
          name: '数学',
          domain: 'math',
          parent_id: null,
          created_at: now,
          updated_at: now,
        });
      await db.insert(schema.knowledge).values(
        families.map((name, i) => ({
          id: `sb1986:kc:${i}`,
          name,
          parent_id: rootId,
          created_at: now,
          updated_at: now,
        })),
      );
      const corpus: Array<{ id: string; family: number; ref: string | null; text: string }> = [];
      for (let i = 0; i < 475; i++) {
        const id = `sb1986:${String(i).padStart(3, '0')}`;
        const c = content(i);
        const [row] = await db
          .insert(schema.question)
          .values({
            id,
            kind: 'choice',
            prompt_md: c.prompt,
            reference_md: `B\n\n答案为${c.answer}。解法：${c.method}。关键步骤：${c.step}。`,
            choices_md: ['无法由条件确定', c.answer, '以上都不对'],
            knowledge_ids: [`sb1986:kc:${i % 12}`],
            difficulty: 1 + (i % 4),
            source: 'manual',
            draft_status: i < 101 ? 'active' : 'draft',
            metadata: { synthetic_search_fixture: true, family: families[i % 12] },
            version: 0,
            created_at: now,
            updated_at: now,
          })
          .returning();
        let ref: string | null = null;
        if (i < 101) {
          const full = normalizeQuestionGroupToContract(row, []);
          const keyed = normalizeQuestionGroupToContract({ ...row, reference_md: 'B' }, []);
          const contract = { ...keyed, structure: full.structure };
          contract.integrity_digest = contractIntegrityDigest(contract);
          const pub = await publishQuestionGroup(db, {
            group_id: id,
            contract,
            expectedCurrentRevision: null,
            expectedAdmissionGeneration: null,
            actorRef: 'synthetic-search-fixture',
            admission: {
              state: 'admitted',
              evidence: {
                marking_provenance: 'official',
                verification: { structural_check_passed: true, independent_verification: null },
                model_slice: null,
              },
            },
            availability: 'general_pool',
            now,
          });
          if (pub.status !== 'published') throw Error(`Fixture publication failed: ${pub.status}`);
          ref = encodeBankRef(pub.revision_id, pub.revision_digest);
          if (i < 100) {
            const prior = SolutionPriorPart.parse({
              part_id: id,
              methods: Array.from({ length: i < 46 ? 3 : 2 }, (_, j) => ({
                core_idea_md: `${c.method}（表述${j + 1}）`,
                key_step_md: c.step,
                steps_md: [c.step],
              })),
              pitfalls: Array.from({ length: i < 35 ? 5 : 4 }, (_, j) => ({
                mechanism_md: `忽略题目条件${j + 1}`,
                trigger_md: c.prompt.slice(0, 100),
              })),
              prerequisites: [{ name_md: families[i % 12], knowledge_id: `sb1986:kc:${i % 12}` }],
              difficulty: null,
            });
            await db.insert(schema.question_solution_prior).values({
              revision_id: pub.revision_id,
              part_id: id,
              prior_version: 'solution-prior-v1',
              prior,
              origin: 'backfill',
              backfill_run_id: 'synthetic-writer-proposed',
              task_run_ids: [],
              created_at: now,
            });
          }
        }
        corpus.push({ id, family: i % 12, ref, text: c.prompt });
      }
      writeFileSync(join(output, 'corpus-own-synthetic.json'), JSON.stringify(corpus, null, 2));
      writeGoldProposal(output, corpus);
      if (process.argv.includes('--seed-only')) {
        console.log(
          'Seeded 475 questions /101 admitted /100 prior; vectors NOT_FILLED, human gold NOT_APPROVED',
        );
        return;
      }
    }
    const reuseUrl = process.env.SEARCH_BENCH_REUSE_DATABASE_URL;
    if (!reuseUrl) assertSearchBenchmarkPaidGate(output);
    if (EMBED_MODEL !== 'text-embedding-v4' || (!reuseUrl && !process.env.DASHSCOPE_API_KEY))
      throw Error('Real v4 route/key required for vector filling');
    const rows = await db.select().from(schema.question);
    const questionTexts = rows.filter(
      (q) => !['sb1986:470', 'sb1986:471', 'sb1986:472', 'sb1986:473', 'sb1986:474'].includes(q.id),
    );
    const priorRows = await db.select().from(schema.question_solution_prior);
    const facets = priorRows.flatMap((p) =>
      solutionPriorFacetTexts(SolutionPriorPart.parse(p.prior)).map((f) => ({
        ...f,
        revision_id: p.revision_id,
        part_id: p.part_id,
      })),
    );
    const upper =
      [...questionTexts.map(questionEmbedText), ...facets.map((f) => f.text)].reduce(
        (n, t) => n + Buffer.byteLength(t),
        0,
      ) / 1e6;
    console.log(
      JSON.stringify({
        vector_rows: questionTexts.length + facets.length,
        conservative_usd_preflight: upper,
        pricing_assumption: '1 USD/M input tokens and UTF8-byte token upper bound, not invoice',
      }),
    );
    if (upper > 0.4) throw Error('Fixture embedding reserve exceeds preregistered $0.40 bound');
    const budgetGuard = reuseUrl ? null : guardSearchBenchmarkEmbedding(output, 0.4);
    const reused = new Map<string, number[]>();
    if (reuseUrl) {
      const source = new URL(reuseUrl);
      if (
        source.hostname !== '127.0.0.1' ||
        source.port !== '5434' ||
        source.pathname !== '/loom_dev_yuk1986_v3'
      )
        throw Error('Only the original owned synthetic vectors from this line may be reused');
      const previous = postgres(reuseUrl, { max: 1 });
      try {
        const qrows = await previous`select * from question`;
        if (
          qrows.some(
            (q) => !q.id.startsWith('sb1986:') || q.metadata?.synthetic_search_fixture !== true,
          )
        )
          throw Error('Vector source is not the owned fixture');
        for (const q of qrows)
          if (
            q.embedding &&
            q.embed_model === EMBED_MODEL &&
            q.embed_version === EMBED_VERSION &&
            q.embed_content_hash ===
              embedHash(questionEmbedText(q as (typeof questionTexts)[number]))
          )
            reused.set(
              q.embed_content_hash,
              typeof q.embedding === 'string' ? JSON.parse(q.embedding) : q.embedding,
            );
        const prows =
          await previous`select v.*,p.prior from question_solution_prior_vector v join question_solution_prior p using(revision_id,part_id)`;
        for (const p of prows)
          if (
            p.embed_model === EMBED_MODEL &&
            p.embed_version === EMBED_VERSION &&
            solutionPriorFacetTexts(SolutionPriorPart.parse(p.prior)).some(
              (f) => embedHash(f.text) === p.content_hash,
            )
          )
            reused.set(
              p.content_hash,
              typeof p.embedding === 'string' ? JSON.parse(p.embedding) : p.embedding,
            );
      } finally {
        await previous.end();
      }
    }
    const vectorsFor = async (texts: string[]) =>
      reuseUrl
        ? texts.map((text) => {
            const v = reused.get(embedHash(text));
            if (!v || v.length !== 1024)
              throw Error('Exact-input real vector missing; never invent or restamp one');
            return v;
          })
        : embedMany(texts, attempt);
    const attempt = { db, caller: 'api' as const, deadlineAt: new Date(Date.now() + 30 * 60_000) };
    for (let i = 0; i < questionTexts.length; i += 10) {
      const batch = questionTexts.slice(i, i + 10),
        vectors = await vectorsFor(batch.map(questionEmbedText));
      for (let j = 0; j < batch.length; j++)
        await db
          .update(schema.question)
          .set({
            embedding: vectors[j],
            embed_model: EMBED_MODEL,
            embed_version: EMBED_VERSION,
            embed_content_hash: embedHash(questionEmbedText(batch[j])),
            embed_source_revision: batch[j].version,
          })
          .where(eq(schema.question.id, batch[j].id));
    }
    for (let i = 0; i < facets.length; i += 10) {
      const batch = facets.slice(i, i + 10),
        vectors = await vectorsFor(batch.map((f) => f.text));
      await db.insert(schema.question_solution_prior_vector).values(
        batch.map((f, j) => ({
          revision_id: f.revision_id,
          part_id: f.part_id,
          facet: f.facet,
          idx: f.idx,
          embedding: vectors[j],
          embed_model: EMBED_MODEL,
          embed_version: EMBED_VERSION,
          content_hash: embedHash(f.text),
        })),
      );
    }
    await db.execute(
      sql.raw(
        "CREATE FUNCTION sb1986_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic search corpus frozen; bank writes are disabled for this acceptance'; END $$",
      ),
    );
    for (const table of [
      'question',
      'question_group_lifecycle',
      'question_solution_prior',
      'question_solution_prior_vector',
    ])
      await db.execute(
        sql.raw(
          `CREATE TRIGGER sb1986_frozen BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION sb1986_freeze()`,
        ),
      );
    budgetGuard?.assertHealthy();
    budgetGuard?.restore();
    if (reuseUrl)
      writeFileSync(
        join(output, 'vector-reuse.json'),
        JSON.stringify(
          {
            source: 'owned previous synthetic corpus',
            exact_input_hash_match: true,
            remote_calls: 0,
            rows: 1151,
          },
          null,
          2,
        ),
      );
    console.log(
      'Fixture frozen:475/101/470+681; no model-generated question can drift into the bank',
    );
  } finally {
    await client.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
