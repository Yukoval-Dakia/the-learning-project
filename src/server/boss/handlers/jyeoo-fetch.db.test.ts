// YUK-697 — jyeoo_fetch handler end-to-end db test (real Postgres).
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。
// The jyeoo-rs subprocess is injected (spawnJyeooFn) so we drive canned NDJSON + exit
// dispositions deterministically — no real binary, no network.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import type { EnqueueSourceVerifyFn } from '@/server/boss/handlers/jyeoo-fetch';
import { runJyeooFetch } from '@/server/boss/handlers/jyeoo-fetch';
import type { SpawnJyeooFn, SpawnJyeooResult } from '@/server/question-supply/jyeoo-spawn';
import { canonicalQuestionContentHash } from '@/server/quiz/content-fingerprint';
import { resetDb } from '../../../../tests/helpers/db';

async function seedKnowledge(id: string, domain = 'math', name = '函数与导数') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id, name, domain, parent_id: null, created_at: now, updated_at: now, version: 0 })
    .onConflictDoNothing();
}

// A child KC whose OWN domain is null — its subject is inherited from `parentId` (the
// normal knowledge-tree shape). Exercises the effective-domain walk.
async function seedChildKnowledge(id: string, parentId: string, name = '导数应用') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name,
      domain: null,
      parent_id: parentId,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

interface SeedQuestionOpts {
  knowledgeIds: string[];
  prompt: string;
  reference?: string;
  choices?: string[] | null;
  draftStatus?: string | null;
  withCanonicalHash?: boolean;
}

async function seedExistingQuestion(opts: SeedQuestionOpts): Promise<string> {
  const id = createId();
  const now = new Date();
  const reference = opts.reference ?? '参考答案';
  const choices = opts.choices === undefined ? null : opts.choices;
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: opts.prompt,
    reference_md: reference,
    rubric_json: null,
    choices_md: choices,
    judge_kind_override: 'semantic',
    knowledge_ids: opts.knowledgeIds,
    difficulty: 3,
    source: 'web_sourced',
    source_ref: 'https://example.edu/q',
    draft_status: opts.draftStatus === undefined ? null : opts.draftStatus,
    created_by: { by: 'system', task_kind: 'seed' },
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
    ...(opts.withCanonicalHash
      ? {
          canonical_content_hash: canonicalQuestionContentHash({
            promptMd: opts.prompt,
            referenceMd: reference,
            choicesMd: choices,
            rubricJson: null,
          }),
        }
      : {}),
  });
  return id;
}

// One valid jyeoo → loom NDJSON envelope line. `q` overrides the question fields, `meta`
// the jyeoo extension block.
function line(q: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    question: {
      kind: 'choice',
      prompt_md: '若 $f(x)=\\ln x$，则 $f(1)=$（　）',
      reference_md: '【答案】B\n\n【解答】$f(1)=\\ln 1=0$。',
      choices_md: ['A．2', 'B．0', 'C．4', 'D．5'],
      judge_kind_override: 'exact',
      difficulty: 3,
      knowledge_ids: [],
      source_url: `https://www.jyeoo.com/math2/ques/detail/${createId()}`,
      source_title: '（2026•孝南区校级三模）',
      extraction_hash: `sha256:${createId()}`,
      extract: '若 f(x)=ln x，则 f(1)= 答案：B',
      ...q,
    },
    jyeoo: { id: 'jid', subject: 'math2', knowledge_hints: ['函数'], vip: true, ...meta },
  });
}

function spawnResult(over: Partial<SpawnJyeooResult> & { lines: string[] }): SpawnJyeooResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdoutTruncated: false,
    stderr: '',
    stderrTruncated: false,
    ...over,
  };
}

// A spawn seam that returns a canned result + records whether it was invoked.
function fakeSpawn(result: SpawnJyeooResult): { fn: SpawnJyeooFn; called: () => boolean } {
  let invoked = false;
  const fn: SpawnJyeooFn = async () => {
    invoked = true;
    return result;
  };
  return { fn, called: () => invoked };
}

function captureEnqueue(): { fn: EnqueueSourceVerifyFn; ids: string[][] } {
  const ids: string[][] = [];
  const fn: EnqueueSourceVerifyFn = async (questionIds) => {
    ids.push(questionIds);
  };
  return { fn, ids };
}

describe('runJyeooFetch', () => {
  const prevFlag = process.env.JYEOO_FETCH_ENABLED;
  beforeEach(async () => {
    await resetDb();
    process.env.JYEOO_FETCH_ENABLED = '1';
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    if (prevFlag === undefined) delete process.env.JYEOO_FETCH_ENABLED;
    else process.env.JYEOO_FETCH_ENABLED = prevFlag;
  });

  it('happy path: validates NDJSON, INSERTs drafts, chains source_verify', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // Two DISTINCT prompts — identical prompts would (correctly) trip the in-batch
    // near-dup prefilter, so the fixture must vary them to exercise a 2-draft ingest.
    const spawn = fakeSpawn(
      spawnResult({
        lines: [
          line({ prompt_md: '若 $f(x)=\\ln x$，则 $f(1)=$（　）' }),
          line({ prompt_md: '设集合 $A=\\{1,2,3\\}$，$B=\\{2,3,4\\}$，则 $A\\cap B=$（　）' }),
          '',
        ],
      }),
    );
    const enqueue = captureEnqueue();

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: enqueue.fn,
    });

    expect(result.status).toBe('ready');
    expect(result.question_ids).toHaveLength(2);
    expect(result.counts).toMatchObject({
      fetched: 2,
      validated: 2,
      inserted: 2,
      filtered_image: 0,
    });

    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.draft_status).toBe('draft');
      expect(r.knowledge_ids).toEqual([kid]);
      expect(r.source_ref).toContain('jyeoo.com');
      const meta = r.metadata as {
        source_ref_kind: string;
        web_sourced: { whitelist_match: boolean; extract: string };
        difficulty_evidence: { source_route: string };
      };
      expect(meta.source_ref_kind).toBe('url');
      // www.jyeoo.com is on the math profile whitelist (YUK-697) → whitelist_match true.
      expect(meta.web_sourced.whitelist_match).toBe(true);
      expect(meta.web_sourced.extract).toBeTruthy();
      expect(meta.difficulty_evidence.source_route).toBe('jyeoo_fetch');
    }

    // source_verify was enqueued exactly once with both draft ids.
    expect(enqueue.ids).toHaveLength(1);
    expect(enqueue.ids[0]).toEqual(expect.arrayContaining(result.question_ids ?? []));

    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:jyeoo_fetch'));
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('success');
    // The event is written AFTER source_verify dispatch, so verify_enqueued is the real
    // count (2), not the frozen-at-0 value a pre-dispatch write would produce.
    const eventCounts = (
      events[0]?.payload as { counts: { inserted: number; verify_enqueued: number } }
    ).counts;
    expect(eventCounts.inserted).toBe(2);
    expect(eventCounts.verify_enqueued).toBe(2);
  });

  it('malformed NDJSON: drops the bad line, ingests the valid ones', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const spawn = fakeSpawn(
      spawnResult({
        lines: [
          line({ prompt_md: '若 $f(x)=\\ln x$，则 $f(1)=$（　）' }),
          '{"question": {broken',
          line({ prompt_md: '设集合 $A=\\{1,2,3\\}$，$B=\\{2,3,4\\}$，则 $A\\cap B=$（　）' }),
          '',
        ],
      }),
    );

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('ready');
    expect(result.counts).toMatchObject({ fetched: 3, validated: 2, invalid: 1, inserted: 2 });
  });

  it('partial process failure (non-zero exit 3 = auth): whole batch discarded, no INSERT', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // Emitted a line, then crashed with a non-zero exit → must NOT ingest the partial.
    const spawn = fakeSpawn(spawnResult({ exitCode: 3, lines: [line(), ''] }));
    const enqueue = captureEnqueue();

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: enqueue.fn,
    });

    expect(result.status).toBe('failed:auth');
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(0);
    expect(enqueue.ids).toHaveLength(0);
    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:jyeoo_fetch'));
    expect(events[0]?.outcome).toBe('failure');
    expect((events[0]?.payload as { failure_class: string }).failure_class).toBe('auth');
  });

  it('network exit (4) is retryable → throws so pg-boss redelivers', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const spawn = fakeSpawn(spawnResult({ exitCode: 4, lines: [''] }));
    await expect(
      runJyeooFetch({
        db,
        trigger: 'knowledge',
        refId: kid,
        knowledgeId: kid,
        spawnJyeooFn: spawn.fn,
        enqueueSourceVerify: captureEnqueue().fn,
      }),
    ).rejects.toThrow(/network/);
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('VIP expiry (per-line vip:false): whole batch discarded, no INSERT', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const spawn = fakeSpawn(spawnResult({ lines: [line({}, { vip: false }), ''] }));

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('failed:vip');
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('VIP expiry (exit 6): whole batch discarded', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const spawn = fakeSpawn(spawnResult({ exitCode: 6, lines: [''] }));
    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });
    expect(result.status).toBe('failed:vip');
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('exact duplicate (canonical content hash, any KC): skipped, not re-INSERTed', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // Same content already exists attributed to a DIFFERENT KC (so the near-dup pool,
    // scoped to the anchor KC, does NOT see it — this isolates the exact-hash path).
    const dupLine = line();
    const dupQuestion = JSON.parse(dupLine).question;
    await seedExistingQuestion({
      knowledgeIds: ['other-kc'],
      prompt: dupQuestion.prompt_md,
      reference: dupQuestion.reference_md,
      choices: dupQuestion.choices_md,
      draftStatus: null,
      withCanonicalHash: true,
    });

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [dupLine, ''] })).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.counts?.deduped_exact).toBe(1);
    expect(result.counts?.inserted).toBe(0);
    // Only the seeded row exists — no new jyeoo draft.
    const jyeooRows = await db
      .select()
      .from(question)
      .where(and(eq(question.source, 'web_sourced'), eq(question.difficulty, 3)));
    expect(jyeooRows.filter((r) => (r.knowledge_ids as string[]).includes(kid))).toHaveLength(0);
  });

  it('near-duplicate (same prompt shares anchor KC in the draft pool): skipped', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const dupLine = line();
    const dupPrompt = JSON.parse(dupLine).question.prompt_md;
    // A DRAFT sharing the anchor KC with the SAME prompt but a different reference →
    // n-gram prompt overlap = 1.0 ≥ threshold (near-dup), yet a different canonical hash
    // (reference differs) so it is NOT an exact dup. Proves the pre-INSERT near-dup
    // prefilter runs against DRAFTS (source_verify's active-only dedup would miss this).
    await seedExistingQuestion({
      knowledgeIds: [kid],
      prompt: dupPrompt,
      reference: '一个完全不同的参考答案文本',
      draftStatus: 'draft',
    });

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [dupLine, ''] })).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.counts?.deduped_near).toBe(1);
    expect(result.counts?.inserted).toBe(0);
  });

  it('image-dependent question: filtered pre-persist, not INSERTed', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const imgLine = line({
      prompt_md: '函数图象如图 ![图](https://www.jyeoo.com/f.png) 所示，则（　）',
    });
    const enqueue = captureEnqueue();

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [imgLine, ''] })).fn,
      enqueueSourceVerify: enqueue.fn,
    });

    expect(result.status).toBe('ready');
    expect(result.counts).toMatchObject({ validated: 1, filtered_image: 1, inserted: 0 });
    expect(await db.select().from(question)).toHaveLength(0);
    // No drafts → no empty source_verify enqueue.
    expect(enqueue.ids).toHaveLength(0);
  });

  it('foreign source_url host: filtered pre-persist (per-row; the batch continues)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // One valid jyeoo-host line + one line whose source_url is a NON-jyeoo host. The foreign
    // row is dropped + counted; the jyeoo row still ingests (per-row filter, not batch fail).
    const foreign = line({
      prompt_md: '异 host 混入题',
      source_url: `https://mirror.example.com/math2/ques/detail/${createId()}`,
    });
    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [line(), foreign, ''] })).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('ready');
    expect(result.counts).toMatchObject({ validated: 2, filtered_url: 1, inserted: 1 });
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_ref).toContain('www.jyeoo.com');
  });

  it('kill switch OFF: no-op (skipped:disabled), spawn never invoked', async () => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.JYEOO_FETCH_ENABLED;
    const kid = createId();
    await seedKnowledge(kid);
    const spawn = fakeSpawn(spawnResult({ lines: [line(), ''] }));

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('skipped:disabled');
    expect(spawn.called()).toBe(false);
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('unsupported subject (no jyeooSupply): skipped, spawn never invoked', async () => {
    const kid = createId();
    await seedKnowledge(kid, 'yuwen');
    const spawn = fakeSpawn(spawnResult({ lines: [line(), ''] }));

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn.fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('skipped:subject_unsupported');
    expect(spawn.called()).toBe(false);
  });

  it('missing knowledge anchor: skipped:ref_not_found', async () => {
    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: createId(),
      knowledgeId: createId(),
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [] })).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });
    expect(result.status).toBe('skipped:ref_not_found');
  });

  it('child KC inheriting parent domain is NOT skipped as unsupported (effective domain)', async () => {
    // Child's own domain is null; the effective domain walk resolves it to the parent's
    // 'math' → jyeooSupply present → ingests instead of a false skipped:subject_unsupported.
    const parent = createId();
    const child = createId();
    await seedKnowledge(parent, 'math');
    await seedChildKnowledge(child, parent);

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: child,
      knowledgeId: child,
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [line(), ''] })).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('ready');
    expect(result.counts?.inserted).toBe(1);
    const rows = await db.select().from(question);
    expect(rows[0]?.knowledge_ids).toEqual([child]);
  });

  it('drops a producer question whose kind does not match the pinned kind', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // Target pinned `choice` (e.g. calibration); producer inferred `short_answer` → filtered
    // pre-persist so a wrong-kind draft can't pass source_verify with the gap still open.
    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      kind: 'choice',
      spawnJyeooFn: fakeSpawn(
        spawnResult({ lines: [line({ kind: 'short_answer', choices_md: null }), ''] }),
      ).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });

    expect(result.status).toBe('ready');
    expect(result.counts).toMatchObject({ validated: 1, filtered_kind: 1, inserted: 0 });
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('keeps a producer question whose kind matches the pinned kind', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // Pin `choice`; producer returns `choice` → not filtered (kindsMatch canonicalizes both).
    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      kind: 'choice',
      spawnJyeooFn: fakeSpawn(spawnResult({ lines: [line(), ''] })).fn,
      enqueueSourceVerify: captureEnqueue().fn,
    });
    expect(result.counts).toMatchObject({ filtered_kind: 0, inserted: 1 });
  });
});
