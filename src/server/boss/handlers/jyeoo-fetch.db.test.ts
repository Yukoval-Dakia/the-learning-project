// YUK-697 — jyeoo_fetch handler end-to-end db test (real Postgres).
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。
// The jyeoo-rs subprocess is injected (spawnJyeooFn) so we drive canned NDJSON + exit
// dispositions deterministically — no real binary, no network.

import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, question, source_asset } from '@/db/schema';
import type { EnqueueSourceVerifyFn } from '@/server/boss/handlers/jyeoo-fetch';
import { runJyeooFetch } from '@/server/boss/handlers/jyeoo-fetch';
import type { SpawnJyeooFn, SpawnJyeooResult } from '@/server/question-supply/jyeoo-spawn';
import { canonicalQuestionContentHash } from '@/server/quiz/content-fingerprint';
import type { R2Client } from '@/server/r2';
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

function captureR2(): {
  client: R2Client;
  puts: Array<{ key: string; mime?: string }>;
  objects: Map<string, Uint8Array>;
} {
  const puts: Array<{ key: string; mime?: string }> = [];
  const objects = new Map<string, Uint8Array>();
  return {
    puts,
    objects,
    client: {
      async put(key, body, mime) {
        puts.push({ key, mime });
        objects.set(key, body.slice());
      },
      async get(key) {
        return objects.get(key) ?? null;
      },
      async delete(key) {
        objects.delete(key);
      },
    },
  };
}

async function validPng(rgb: { r: number; g: number; b: number }): Promise<Uint8Array> {
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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

  it('failed image localization filters only that question and keeps the text batch alive', async () => {
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
      spawnJyeooFn: fakeSpawn(
        spawnResult({
          lines: [
            imgLine,
            line({ prompt_md: '纯文本候选：已知 $f(x)=x^2$，则 $f(2)=$（　）' }),
            '',
          ],
        }),
      ).fn,
      enqueueSourceVerify: enqueue.fn,
    });

    expect(result.status).toBe('ready');
    expect(result.counts).toMatchObject({ validated: 2, filtered_image: 1, inserted: 1 });
    expect(await db.select().from(question)).toHaveLength(1);
    expect(enqueue.ids).toHaveLength(1);
  });

  it('localized image: uploads to R2, creates source_asset, rewrites markdown, and writes figures', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const r2 = captureR2();
    let runImageDir = '';
    const png = await validPng({ r: 20, g: 80, b: 160 });
    const spawn: SpawnJyeooFn = async (options) => {
      const imagesArg = options.args.indexOf('--images');
      expect(imagesArg).toBeGreaterThanOrEqual(0);
      runImageDir = options.args[imagesArg + 1] ?? '';
      const imagePath = join(runImageDir, 'figure.png');
      await writeFile(imagePath, png);
      return spawnResult({
        lines: [
          line({
            prompt_md: `函数图象如图 ![函数图](${imagePath}) 所示，则（　）`,
            reference_md: `【答案】B\n\n【解答】参见 ![函数图](${imagePath})`,
            choices_md: ['A．2', `B．0 ![函数图](${imagePath})`, 'C．4', 'D．5'],
          }),
          '',
        ],
      });
    };
    const enqueue = captureEnqueue();

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn,
      enqueueSourceVerify: enqueue.fn,
      r2: r2.client,
    });

    expect(result.counts).toMatchObject({ validated: 1, filtered_image: 0, inserted: 1 });
    const [asset] = await db.select().from(source_asset);
    expect(asset).toMatchObject({ kind: 'image', mime_type: 'image/png', byte_size: png.length });
    expect(r2.puts).toEqual([{ key: asset?.storage_key, mime: 'image/png' }]);

    const [row] = await db.select().from(question);
    const internalUrl = `/api/assets/${asset?.id}/content`;
    expect(row?.prompt_md).toContain(`![函数图](${internalUrl})`);
    expect(row?.reference_md).toContain(`![函数图](${internalUrl})`);
    expect(row?.choices_md?.[1]).toContain(`![函数图](${internalUrl})`);
    expect(row?.prompt_md).not.toContain(runImageDir);
    expect(row?.judge_kind_override).toBe('multimodal_direct');
    expect(row?.image_refs).toEqual([asset?.id]);
    expect(row?.figures).toEqual([
      {
        asset_id: asset?.id,
        role: 'diagram',
        source_page_index: 0,
        source_bbox: { x: 0, y: 0, width: 1, height: 1 },
        attached_to_index: row?.id,
        attach_confidence: 'high',
      },
    ]);
    expect(row?.structured).toMatchObject({
      id: row?.id,
      role: 'standalone',
      prompt_text: row?.prompt_md,
    });
    expect((row?.metadata as { prompt_image_refs?: string[] }).prompt_image_refs).toEqual([
      asset?.id,
    ]);
    expect(
      (row?.metadata as { web_sourced?: { extraction_hash?: string } }).web_sourced
        ?.extraction_hash,
    ).toBe(`sha256:${row?.canonical_content_hash}`);
    expect(enqueue.ids).toEqual([[row?.id]]);
    await expect(access(runImageDir)).rejects.toThrow();
  });

  it('localizes distinct prompt, reference-only, and choice-only images without field bleed', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const r2 = captureR2();
    const images = await Promise.all([
      validPng({ r: 220, g: 20, b: 20 }),
      validPng({ r: 20, g: 220, b: 20 }),
      validPng({ r: 20, g: 20, b: 220 }),
    ]);
    const spawn: SpawnJyeooFn = async (options) => {
      const dir = options.args[options.args.indexOf('--images') + 1] ?? '';
      const paths = ['prompt.png', 'reference.png', 'choice.png'].map((name) => join(dir, name));
      await Promise.all(paths.map((path, index) => writeFile(path, images[index] as Uint8Array)));
      return spawnResult({
        lines: [
          line({
            prompt_md: `看图 ![题图](${paths[0]}) 作答`,
            reference_md: `答案 B；解析图 ![解析图](${paths[1]})`,
            choices_md: ['A．1', `B．2 ![选项图](${paths[2]})`],
          }),
          '',
        ],
      });
    };

    await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: spawn,
      enqueueSourceVerify: captureEnqueue().fn,
      r2: r2.client,
    });

    const assets = await db.select().from(source_asset);
    const [row] = await db.select().from(question);
    expect(assets).toHaveLength(3);
    expect(row?.image_refs).toHaveLength(2);
    expect(row?.figures).toHaveLength(2);
    expect(row?.prompt_md).toMatch(/!\[题图\]\(\/api\/assets\/[^/]+\/content\)/);
    expect(row?.reference_md).toMatch(/!\[解析图\]\(\/api\/assets\/[^/]+\/content\)/);
    expect(row?.choices_md?.[1]).toMatch(/!\[选项图\]\(\/api\/assets\/[^/]+\/content\)/);
  });

  it('includes image bytes in exact identity when text and alt are identical', async () => {
    const k1 = createId();
    const k2 = createId();
    await seedKnowledge(k1);
    await seedKnowledge(k2);
    const r2 = captureR2();
    const run = async (kid: string, png: Uint8Array) =>
      runJyeooFetch({
        db,
        trigger: 'knowledge',
        refId: kid,
        knowledgeId: kid,
        spawnJyeooFn: async (options) => {
          const dir = options.args[options.args.indexOf('--images') + 1] ?? '';
          const path = join(dir, 'same-name.png');
          await writeFile(path, png);
          return spawnResult({
            lines: [line({ prompt_md: `同一题文 ![图](${path})`, reference_md: '答案 B' }), ''],
          });
        },
        enqueueSourceVerify: captureEnqueue().fn,
        r2: r2.client,
      });

    await run(k1, await validPng({ r: 255, g: 0, b: 0 }));
    await run(k2, await validPng({ r: 0, g: 0, b: 255 }));

    const rows = await db.select().from(question);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.canonical_content_hash).not.toBe(rows[1]?.canonical_content_hash);
  });

  it('dedupes identical pixels across balanced temp paths before a second upload', async () => {
    const k1 = createId();
    const k2 = createId();
    await seedKnowledge(k1);
    await seedKnowledge(k2);
    const r2 = captureR2();
    const png = await validPng({ r: 90, g: 90, b: 90 });
    const run = async (kid: string, filename: string) =>
      runJyeooFetch({
        db,
        trigger: 'knowledge',
        refId: kid,
        knowledgeId: kid,
        spawnJyeooFn: async (options) => {
          const dir = options.args[options.args.indexOf('--images') + 1] ?? '';
          const path = join(dir, filename);
          await writeFile(path, png);
          return spawnResult({
            lines: [line({ prompt_md: `同一题文 ![图](${path})`, reference_md: '答案 B' }), ''],
          });
        },
        enqueueSourceVerify: captureEnqueue().fn,
        r2: r2.client,
      });

    await run(k1, 'Foo_(bar).png');
    const second = await run(k2, 'another.png');

    expect(second.counts).toMatchObject({ deduped_exact: 1, inserted: 0 });
    expect(await db.select().from(question)).toHaveLength(1);
    expect(r2.puts).toHaveLength(1);
  });

  it('filters an unclosed markdown image destination instead of persisting a temp path', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: async (options) => {
        const dir = options.args[options.args.indexOf('--images') + 1] ?? '';
        return spawnResult({
          lines: [line({ prompt_md: `坏图 ![图](${join(dir, 'missing.png')}` }), ''],
        });
      },
      enqueueSourceVerify: captureEnqueue().fn,
      r2: captureR2().client,
    });

    expect(result.counts).toMatchObject({ filtered_image: 1, inserted: 0 });
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('compensates source_asset and R2 when the question transaction never starts', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const r2 = captureR2();
    const png = await validPng({ r: 70, g: 80, b: 90 });

    await expect(
      runJyeooFetch({
        db,
        trigger: 'knowledge',
        refId: kid,
        knowledgeId: kid,
        spawnJyeooFn: async (options) => {
          const dir = options.args[options.args.indexOf('--images') + 1] ?? '';
          const path = join(dir, 'owned.png');
          await writeFile(path, png);
          return spawnResult({ lines: [line({ prompt_md: `看图 ![图](${path})` }), ''] });
        },
        enqueueSourceVerify: captureEnqueue().fn,
        r2: r2.client,
        afterAssetsPersistedFn: async () => {
          throw new Error('injected after asset finalization');
        },
      }),
    ).rejects.toThrow('injected after asset finalization');

    expect(await db.select().from(source_asset)).toHaveLength(0);
    expect(r2.objects.size).toBe(0);
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('compensates uploaded assets after losing the canonical reservation race', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    const r2 = captureR2();
    const png = await validPng({ r: 15, g: 25, b: 35 });
    let competitorId = '';

    const result = await runJyeooFetch({
      db,
      trigger: 'knowledge',
      refId: kid,
      knowledgeId: kid,
      spawnJyeooFn: async (options) => {
        const dir = options.args[options.args.indexOf('--images') + 1] ?? '';
        const path = join(dir, 'race.png');
        await writeFile(path, png);
        return spawnResult({ lines: [line({ prompt_md: `竞态图题 ![图](${path})` }), ''] });
      },
      enqueueSourceVerify: captureEnqueue().fn,
      r2: r2.client,
      afterAssetsPersistedFn: async ({ canonicalContentHash }) => {
        competitorId = createId();
        const now = new Date();
        await db.insert(question).values({
          id: competitorId,
          kind: 'choice',
          prompt_md: '并发胜者',
          reference_md: 'B',
          choices_md: ['A', 'B'],
          judge_kind_override: 'exact',
          knowledge_ids: [kid],
          difficulty: 3,
          source: 'manual',
          draft_status: 'draft',
          created_by: { by: 'system', task_kind: 'test-race' },
          metadata: {},
          canonical_content_hash: canonicalContentHash,
          created_at: now,
          updated_at: now,
          version: 0,
        });
      },
    });

    expect(result.counts).toMatchObject({ deduped_exact: 1, inserted: 0 });
    expect((await db.select().from(question)).map((row) => row.id)).toEqual([competitorId]);
    expect(await db.select().from(source_asset)).toHaveLength(0);
    expect(r2.objects.size).toBe(0);
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
