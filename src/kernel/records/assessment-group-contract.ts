// 组权威契约的唯一解析口：declared 指针优先，未声明时回退 legacy 行归一。
// declared 路径不做 figure 核验（契约已冻结）；legacy 路径如实标注未核验 digest。
// lifecycle 读为快照语义，调用方随后 FOR UPDATE 重读并 CAS，冲突 fail-closed。

import { eq, inArray } from 'drizzle-orm';

import {
  describeAnswerShape,
  findAnswerShapeDeclarations,
  findBlankOrderDeclarations,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  type question,
  question_group_lifecycle,
  question_revision,
  source_asset,
} from '@/db/schema';
import {
  type NormalizedContract,
  type PartRow,
  type PublishedContractSeal,
  normalizeQuestionGroupToContract,
  publishedContractSeal,
} from './assessment-normalization';

/** 组契约解析结果 —— 组快照的契约半边（declared 态附权威 revision id）。 */
export interface ResolvedGroupContract {
  /** declared 态的权威 revision id；走 legacy 行归一时为 null。 */
  declaredRevisionId: string | null;
  contract: NormalizedContract;
}

/**
 * 组根行 + live parts → NormalizedContract。两条路径产出同一形状，integrity_digest
 * 与库内一致，保证 base_contract_digest 可比。declared 读失败 fail-loud，不降级旧解释。
 */
export async function resolveGroupContract(
  db: Db | Tx,
  root: typeof question.$inferSelect,
  liveParts: PartRow[],
): Promise<ResolvedGroupContract> {
  const [declaredLifecycle] = await db
    .select({ revisionId: question_group_lifecycle.current_revision_id })
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, root.id))
    .limit(1);
  if (declaredLifecycle?.revisionId != null) {
    const [current] = await db
      .select({
        revision_id: question_revision.revision_id,
        integrity_digest: question_revision.integrity_digest,
        structure: question_revision.structure,
        response_spec: question_revision.response_spec,
        scoring_basis: question_revision.scoring_basis,
        execution_plan: question_revision.execution_plan,
        presentation: question_revision.presentation,
      })
      .from(question_revision)
      .where(eq(question_revision.revision_id, declaredLifecycle.revisionId))
      .limit(1);
    if (current != null) {
      const shapeDeclarations = findAnswerShapeDeclarations(current.response_spec);
      const orderDeclarations = findBlankOrderDeclarations(current.structure);
      if (shapeDeclarations.length > 0 || orderDeclarations.length > 0) {
        let seal: PublishedContractSeal;
        try {
          seal = publishedContractSeal({
            structure: current.structure,
            response_spec: current.response_spec,
            scoring_basis: current.scoring_basis,
            execution_plan: current.execution_plan,
            ...(current.presentation != null ? { presentation: current.presentation } : {}),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `loadQuestionGroupContractSnapshot: revision '${current.revision_id}' of group '${root.id}' carries answer declarations this reader cannot parse (${
              shapeDeclarations
                .map((d) => `${d.slot_id}:${describeAnswerShape(d.answer_shape)}`)
                .join(', ') ||
              `blank_order on ${orderDeclarations.map((d) => d.part_id).join(', ')}`
            }) — ${detail} — refusing to fall back to the legacy row interpreter`,
          );
        }
        return {
          declaredRevisionId: current.revision_id,
          contract: {
            structure: seal.parsed.structure,
            response_spec: seal.parsed.response_spec,
            scoring_basis: seal.parsed.scoring_basis,
            execution_plan: seal.parsed.execution_plan,
            ...(seal.parsed.presentation != null ? { presentation: seal.parsed.presentation } : {}),
            integrity_digest: current.integrity_digest,
            group_id: root.id,
            conversion_issues: [],
            rule_statement_origins: {},
          },
        };
      }
    }
  }

  // figure 实内容 digest 来自 asset 元数据；缺失即标 unverified，不伪造。
  const figureAssetIds = new Set<string>();
  for (const f of root.figures ?? []) figureAssetIds.add(f.asset_id);
  for (const p of liveParts) for (const f of p.figures ?? []) figureAssetIds.add(f.asset_id);
  const figureDigests: Record<string, string> = {};
  if (figureAssetIds.size > 0) {
    const assetRows = await db
      .select({ assetId: source_asset.id, sha256: source_asset.sha256 })
      .from(source_asset)
      .where(inArray(source_asset.id, [...figureAssetIds]));
    for (const assetRow of assetRows) figureDigests[assetRow.assetId] = assetRow.sha256;
  }

  return {
    declaredRevisionId: null,
    contract: normalizeQuestionGroupToContract(
      { ...(root as Parameters<typeof normalizeQuestionGroupToContract>[0]), figureDigests },
      liveParts,
    ),
  };
}
