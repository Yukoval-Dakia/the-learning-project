// YUK-986 (Supply-Agent/1) — jyeoo_staged_asset_reap：未提交候选的 staged 图片资产回收。
//
// jyeoo_fetch_candidates 把存活候选的图片即期持久化（source_asset provenance
// origin='jyeoo_staged'），候选若最终未被 store_sourced_question 提交（agent 跳过 /
// 会话中断 / commit 拒绝后的兜底），其 source_asset 行 + R2 对象成为孤儿。本 job 每日
// 回收：超过宽限期（默认 24h——覆盖 agent 当日决策链 + 人工排查窗口）且未被任何
// question.image_refs / figures 引用的 staged 资产。
//
// R2 对象仅在没有其他 owner 行时删除（content-addressed 共享语义，与 cleanupStagedAssets
// 一致）。commit 侧即时回收（cleanupStagedForRejected）是主路径，本 job 只兜「连拒绝
// 回调都没走到」的泄漏。

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { question, source_asset } from '@/db/schema';
import {
  type JyeooR2Client,
  lockImageStorageKey,
  resolveJyeooR2,
} from '../server/question-supply/jyeoo-candidates';

export const JYEOO_STAGED_ASSET_GRACE_HOURS = 24;

export interface ReapStagedAssetsResult {
  scanned: number;
  reapedRows: number;
  reapedObjects: number;
  keptReferenced: number;
}

export async function runJyeooStagedAssetReap(
  db: Db,
  deps: { r2?: JyeooR2Client; now?: Date; graceHours?: number } = {},
): Promise<ReapStagedAssetsResult> {
  const now = deps.now ?? new Date();
  const graceHours = deps.graceHours ?? JYEOO_STAGED_ASSET_GRACE_HOURS;
  const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);
  const r2 = deps.r2 ?? resolveJyeooR2();

  const staged = await db
    .select({ id: source_asset.id, storage_key: source_asset.storage_key })
    .from(source_asset)
    .where(
      and(
        sql`${source_asset.provenance}->>'origin' = 'jyeoo_staged'`,
        lt(source_asset.created_at, cutoff),
      ),
    );

  const result: ReapStagedAssetsResult = {
    scanned: staged.length,
    reapedRows: 0,
    reapedObjects: 0,
    keptReferenced: 0,
  };
  if (staged.length === 0) return result;

  const orphanIds: string[] = [];
  for (const asset of staged) {
    // 引用探测：question.image_refs / figures[].asset_id 任一命中即保留。
    const referenced = await db
      .select({ id: question.id })
      .from(question)
      .where(
        sql`(${question.image_refs} @> ${JSON.stringify([asset.id])}::jsonb)
          or (${question.figures} @> ${JSON.stringify([{ asset_id: asset.id }])}::jsonb)`,
      )
      .limit(1);
    if (referenced.length > 0) result.keptReferenced += 1;
    else orphanIds.push(asset.id);
  }
  if (orphanIds.length === 0) return result;

  const orphanRows = await db
    .select({ id: source_asset.id, storage_key: source_asset.storage_key })
    .from(source_asset)
    .where(inArray(source_asset.id, orphanIds));
  const orphanIdSet = new Set(orphanIds);
  const storageKeys = [...new Set(orphanRows.map((row) => row.storage_key))].sort();

  await db.transaction(async (tx) => {
    // 与 persistImageAsset 同一把 content-addressed 锁：回收不得与进行中的写入竞速。
    for (const storageKey of storageKeys) await lockImageStorageKey(tx, storageKey);
    for (const storageKey of storageKeys) {
      const owners = await tx
        .select({ id: source_asset.id })
        .from(source_asset)
        .where(eq(source_asset.storage_key, storageKey));
      if (owners.every((owner) => orphanIdSet.has(owner.id))) {
        await r2.delete(storageKey);
        result.reapedObjects += 1;
      }
    }
    const deleted = await tx
      .delete(source_asset)
      .where(inArray(source_asset.id, orphanIds))
      .returning({ id: source_asset.id });
    result.reapedRows = deleted.length;
  });
  return result;
}

export function buildJyeooStagedAssetReapHandler(db: Db): (jobs: Job<unknown>[]) => Promise<void> {
  return async () => {
    const result = await runJyeooStagedAssetReap(db);
    console.log('[jyeoo_staged_asset_reap]', JSON.stringify(result));
  };
}
