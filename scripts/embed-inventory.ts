// YUK-1448 — read-only question-vector census, run BEFORE spending on a backfill.
//
// 统一问题定级设计 §7：补向量前先清点真实内容 digest、模型/维度/版本、有效 vectors
// ——历史 35/83 只是待核基数，这里给当前真值。纯读：零 embedding 调用、零写。
// 有效判据与 embed_backfill 写入同源（questionVectorInvalidReason）：有向量、
// 维度 = EMBED_DIMS、embed_version = EMBED_VERSION、embed_content_hash = 按当前
// 内容重算的 digest（内容编辑后未回填的行算 hash_mismatch）。
//
// CLI:
//   pnpm embed:inventory                 # summary（最近 5000 行）
//   pnpm embed:inventory --limit 20000   # 扩大清点窗口（上限 20000）
//   pnpm embed:inventory --rows          # 额外逐行输出 JSON（含 content_digest）

// Load `.env` BEFORE importing `@/db/client` (it throws on a missing DATABASE_URL).
import './load-env';

function parseArgs(argv: string[]): { limit: number; rows: boolean } {
  let limit = 5_000;
  let rows = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rows') rows = true;
    else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1)
        throw new Error('--limit needs a positive integer');
      limit = Math.min(value, 20_000);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { limit, rows };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { desc, sql } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { question } = await import('@/db/schema');
  const { EMBED_DIMS, EMBED_MODEL } = await import('@/server/ai/embed');
  const { embedHash, questionEmbedText } = await import('@/server/ai/embed-source');
  const { EMBED_VERSION, questionVectorInvalidReason } = await import(
    '@/capabilities/practice/jobs/embed_backfill'
  );

  const rows = await db
    .select({
      id: question.id,
      parent_question_id: question.parent_question_id,
      draft_status: question.draft_status,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      embed_model: question.embed_model,
      embed_version: question.embed_version,
      embed_content_hash: question.embed_content_hash,
      dimension: sql<number | null>`vector_dims(${question.embedding})`,
    })
    .from(question)
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(args.limit);

  const byReason: Record<string, number> = {};
  let valid = 0;
  const inventory = rows.map((row) => {
    const reason = questionVectorInvalidReason(row);
    if (reason === null) valid += 1;
    else byReason[reason] = (byReason[reason] ?? 0) + 1;
    return {
      question_id: row.id,
      top_level: row.parent_question_id == null,
      draft_status: row.draft_status,
      content_digest: embedHash(questionEmbedText(row)),
      embed_model: row.embed_model,
      dimension: row.dimension,
      embed_version: row.embed_version,
      vector_valid: reason === null,
      invalid_reason: reason,
    };
  });

  console.log(
    JSON.stringify(
      {
        summary: {
          total: rows.length,
          vector_present: rows.filter((row) => row.dimension !== null).length,
          vector_valid: valid,
          invalid_by_reason: byReason,
          window_limit: args.limit,
          expected_model: EMBED_MODEL,
          expected_dimension: EMBED_DIMS,
          expected_version: EMBED_VERSION,
        },
        ...(args.rows ? { rows: inventory } : {}),
      },
      null,
      2,
    ),
  );
  return 0;
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('embed-inventory.ts')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[embed:inventory] failed:', err);
      process.exit(1);
    });
}
