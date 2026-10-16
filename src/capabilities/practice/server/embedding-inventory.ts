// YUK-1448 (Stage 1 batch D) — 只读题库向量清点（read-only inventory）。
//
// 统一问题定级设计 §7：补向量前先清点真实内容 digest、模型/维度/版本、有效
// vectors——历史 35/83 只是待核基数，本模块给出当前真值。跑回填（既有的
// embed_backfill 夜 job）前用它核对缺口量级与陈旧面，费用估算以此为准。
//
// 纯读：零 embedding 调用、零写。valid_vector 判据（全部满足才算有效）：
//   1. embedding IS NOT NULL；
//   2. vector_dims(embedding) = EMBED_DIMS（当前模型维度）；
//   3. embed_version = EMBED_VERSION（当前 join 规则/模型版本）；
//   4. embed_content_hash = 按当前行内容重算的 digest（内容编辑后未回填的行会缺位）。
// 内容编辑失效链（YUK-393）：editQuestion（src/server/questions/write.ts:357-403）
// 在 md 内容漂移时置 NULL embedding + 盖新 hash；发布链新题一律 embedding NULL 落库
// （src/kernel/records/assessment-publication.ts insertQuestionDraft）——两类行都被
// embed_backfill 的 `embedding IS NULL OR embed_version < EMBED_VERSION` 谓词接住，
// 由其 CAS 写守卫（sourceStillCurrent）保证编辑期间旧向量不覆盖新内容。

import { desc, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { EMBED_DIMS, EMBED_MODEL } from '@/server/ai/embed';
import { embedHash, questionEmbedText } from '@/server/ai/embed-source';
import { EMBED_VERSION } from '../jobs/embed_backfill';

export interface QuestionEmbeddingInventoryRow {
  question_id: string;
  /** 组根为 true；part 行嵌入供组内检索，不单独成候选。 */
  top_level: boolean;
  draft_status: string | null;
  /** 按当前行内容（prompt/reference/choices join）重算的内容 digest。 */
  content_digest: string;
  embed_model: string | null;
  /** pgvector 实际维度（无向量为 null）。 */
  dimension: number | null;
  embed_version: number | null;
  vector_present: boolean;
  /** 上述 4 判据全满足才为 true。 */
  vector_valid: boolean;
  invalid_reason: string | null;
}

export interface QuestionEmbeddingInventorySummary {
  total: number;
  vector_present: number;
  vector_valid: number;
  missing_vector: number;
  stale_version: number;
  dimension_mismatch: number;
  hash_mismatch: number;
  expected_model: string;
  expected_dimension: number;
  expected_version: number;
}

export interface QuestionEmbeddingInventory {
  rows: QuestionEmbeddingInventoryRow[];
  summary: QuestionEmbeddingInventorySummary;
}

/**
 * 清点题库行级嵌入状态。只读；不触发任何 provider/embedding 调用。
 * 默认按 created_at 倒序取全部（上限 cap），供回填前核对缺口与陈旧面。
 */
export async function inventoryQuestionEmbeddings(
  db: Db,
  opts: { limit?: number } = {},
): Promise<QuestionEmbeddingInventory> {
  const limit = Math.min(Math.max(opts.limit ?? 5_000, 1), 20_000);
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
      vector_present: sql<boolean>`(${question.embedding} IS NOT NULL)`,
      dimension: sql<number | null>`vector_dims(${question.embedding})`,
    })
    .from(question)
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(limit);

  const summary: QuestionEmbeddingInventorySummary = {
    total: 0,
    vector_present: 0,
    vector_valid: 0,
    missing_vector: 0,
    stale_version: 0,
    dimension_mismatch: 0,
    hash_mismatch: 0,
    expected_model: EMBED_MODEL,
    expected_dimension: EMBED_DIMS,
    expected_version: EMBED_VERSION,
  };

  const inventory: QuestionEmbeddingInventoryRow[] = rows.map((row) => {
    const digest = embedHash(
      questionEmbedText({
        prompt_md: row.prompt_md,
        reference_md: row.reference_md,
        choices_md: row.choices_md,
      }),
    );
    summary.total += 1;
    let invalidReason: string | null = null;
    if (!row.vector_present) {
      summary.missing_vector += 1;
      invalidReason = 'no_vector';
    } else {
      summary.vector_present += 1;
      if (row.dimension !== EMBED_DIMS) {
        summary.dimension_mismatch += 1;
        invalidReason = `dimension_mismatch (stored ${row.dimension ?? 'null'}, expected ${EMBED_DIMS})`;
      } else if (row.embed_version !== EMBED_VERSION) {
        summary.stale_version += 1;
        invalidReason = `stale_version (stored ${row.embed_version ?? 'null'}, expected ${EMBED_VERSION})`;
      } else if (row.embed_content_hash !== digest) {
        summary.hash_mismatch += 1;
        invalidReason = 'hash_mismatch (content changed after embed; awaiting backfill)';
      }
    }
    if (invalidReason === null) summary.vector_valid += 1;
    return {
      question_id: row.id,
      top_level: row.parent_question_id == null,
      draft_status: row.draft_status,
      content_digest: digest,
      embed_model: row.embed_model,
      dimension: row.dimension,
      embed_version: row.embed_version,
      vector_present: row.vector_present,
      vector_valid: invalidReason === null,
      invalid_reason: invalidReason,
    };
  });

  return { rows: inventory, summary };
}
