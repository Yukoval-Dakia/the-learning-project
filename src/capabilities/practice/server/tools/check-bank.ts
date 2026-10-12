// ADR-0072 D1/D5 — check_bank DomainTool：对 agent 显式指定的对象做确定性检查。
//
// v1 只含确定性检查（D5）：记录关系读取 + 已有纯校验器的确定性复算。语义
// （模型）检查未过预注册比较，一律不接入 —— 自由文本 claim 不做解释，无法忠
// 实归一化 → unknown + 支持类清单（硬边界 5：不把难问题改写成容易的问题后仍
// 报 supported）。verdict ∈ supported / contradicted / unknown；method 与依赖版
// 本全披露（提案 §8）。检查只回答指定对象，不说明池外没有其他答案，不替
// agent 拆任务，不碰 learner state。

import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import {
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { bankAssetDigestMatches, readBankServableParts, resolveBankRefs } from './bank-ref';

export const CHECK_BANK_KINDS = [
  'same_material_refs',
  'ref_state',
  'contract_valid',
  'material_assets_present',
] as const;

export type CheckBankKind = (typeof CHECK_BANK_KINDS)[number];

export const CheckBankInputSchema = z
  .object({
    /** v1 恒为 false（确定性 only）。true 不报错，但不会启用任何模型检查——响应 notes 说明。 */
    allow_model: z.boolean().default(false),
    checks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            refs: z.array(z.string().min(1)).min(1).max(8),
            /** 检查意图的原文记录（进响应回显；v1 不解释 claim，机器语义由 kind 决定）。 */
            claim: z.string().max(1000).optional(),
            kind: z.enum(CHECK_BANK_KINDS),
            /** kind 专属参数（如 ref_state 的断言目标）。 */
            params: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

type CheckBankInput = z.infer<typeof CheckBankInputSchema>;

const CheckResultSchema = z.object({
  id: z.string(),
  claim: z.string().optional(),
  interpretation: z.string(),
  verdict: z.enum(['supported', 'contradicted', 'unknown']),
  execution_status: z.enum(['completed', 'failed', 'not_started']),
  method: z.enum(['record_lookup', 'deterministic_recompute', 'record_lookup_and_compare']),
  inputs: z.array(z.string()),
  evidence: z.array(z.record(z.string(), z.unknown())),
  steps: z.array(
    z.object({
      method: z.string(),
      input_refs: z.array(z.string()),
      operation: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});

export const CheckBankOutputSchema = z.object({
  checks: z.array(CheckResultSchema),
  notes: z.array(z.string()),
  supported_kinds: z.array(z.string()),
});

type CheckBankOutput = z.infer<typeof CheckBankOutputSchema>;
type CheckResult = z.infer<typeof CheckResultSchema>;

interface CheckMaterialInfo {
  material_id: string;
  kind: string;
  asset_id: string;
  digest: string;
  content_md?: string;
}

interface CheckRefInfo {
  group_id: string;
  revision_id: string;
  materials: CheckMaterialInfo[];
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  current: boolean;
  withdrawn: boolean;
  suspended: boolean;
  admission_state: 'admitted' | 'withheld' | null;
}

interface CheckContext {
  badRefs: Map<string, string>; // raw ref → error detail
  revisionsByRef: Map<string, CheckRefInfo>;
}

function materialIdentity(material: CheckMaterialInfo): string {
  return JSON.stringify({
    material_id: material.material_id,
    kind: material.kind,
    asset_id: material.asset_id,
    digest: material.digest,
    ...(material.content_md != null ? { content_md: material.content_md } : {}),
  });
}

function unknownResult(
  id: string,
  claim: string | undefined,
  interpretation: string,
  refs: string[],
  reason: string,
  method: CheckResult['method'],
): CheckResult {
  return {
    id,
    ...(claim != null ? { claim } : {}),
    interpretation,
    verdict: 'unknown',
    execution_status: 'completed',
    method,
    inputs: refs,
    evidence: [{ reason }],
    steps: [
      {
        method,
        input_refs: refs,
        operation: '检查前置的 ref 解析未全部成功——缺数据，无法判定',
      },
    ],
    limitations: ['unknown ≠ 证据矛盾：解析失败的 ref 使该检查无法执行，先修复 ref 再查'],
  };
}

export async function runCheckBank(db: Db, rawInput: CheckBankInput): Promise<CheckBankOutput> {
  return db.transaction((tx) => runCheckBankInSnapshot(tx, rawInput), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

async function runCheckBankInSnapshot(
  db: Db | Tx,
  rawInput: CheckBankInput,
): Promise<CheckBankOutput> {
  const input = CheckBankInputSchema.parse(rawInput);
  const notes: string[] = [];
  if (input.allow_model) {
    notes.push(
      'allow_model=true 被接受但 v1 无任何已准入的语义（模型）检查（ADR-0072 D5：逐项过预注册比较才接入）——本响应全部结果均为确定性方法',
    );
  }

  const allRefs = [...new Set(input.checks.flatMap((c) => c.refs))];
  const resolutions = await resolveBankRefs(db, allRefs);
  const servable = input.checks.some(
    (check) => check.kind === 'ref_state' && check.params?.assert === 'is_servable',
  )
    ? await readBankServableParts(
        db,
        resolutions.flatMap((r) => (r.status === 'ok' ? [r.revision.group_id] : [])),
      )
    : new Map<string, string[]>();
  const ctx: CheckContext = { badRefs: new Map(), revisionsByRef: new Map() };
  for (const r of resolutions) {
    if (r.status === 'ok') {
      const materials: CheckMaterialInfo[] = (r.revision.structure?.materials ?? []).map((m) => ({
        material_id: m.material_id,
        kind: m.kind,
        asset_id: m.asset.asset_id,
        digest: m.asset.digest,
        ...(m.content_md != null ? { content_md: m.content_md } : {}),
      }));
      ctx.revisionsByRef.set(r.raw, {
        group_id: r.revision.group_id,
        revision_id: r.revision.revision_id,
        materials,
        structure: r.revision.structure,
        response_spec: r.revision.response_spec,
        scoring_basis: r.revision.scoring_basis,
        current: r.lifecycle?.current_revision_id === r.revision.revision_id,
        withdrawn: r.lifecycle?.withdrawn === true,
        suspended: r.lifecycle?.suspended === true,
        admission_state: r.lifecycle?.scoring_admission_state ?? null,
      });
    } else {
      ctx.badRefs.set(r.raw, `${r.status}: ${r.detail}`);
    }
  }

  // material_assets_present 需要的资产记录（一次批量查）。
  const binaryAssetIds = [
    ...new Set(
      [...ctx.revisionsByRef.values()].flatMap((v) =>
        v.materials.filter((m) => m.content_md == null).map((m) => m.asset_id),
      ),
    ),
  ];
  const assetShaById = new Map<string, string>();
  if (binaryAssetIds.length > 0) {
    const rows = await db
      .select({ id: source_asset.id, sha256: source_asset.sha256 })
      .from(source_asset)
      .where(inArray(source_asset.id, binaryAssetIds));
    for (const row of rows) assetShaById.set(row.id, row.sha256);
  }

  const results: CheckResult[] = [];
  for (const check of input.checks) {
    if (check.claim !== undefined) {
      results.push(
        unknownResult(
          check.id,
          check.claim,
          check.claim,
          check.refs,
          'LIGHT cannot faithfully interpret free-text claims; omit claim to ask only the documented kind/params predicate',
          'record_lookup',
        ),
      );
      continue;
    }
    if (
      check.kind === 'ref_state' &&
      check.params?.assert !== undefined &&
      check.params.assert !== 'is_servable' &&
      check.params.assert !== 'is_current'
    ) {
      results.push(
        unknownResult(
          check.id,
          undefined,
          'unsupported ref_state assertion',
          check.refs,
          'Supported assertions: is_current, is_servable',
          'record_lookup',
        ),
      );
      continue;
    }
    const badInCheck = check.refs.filter((ref) => ctx.badRefs.has(ref));
    const resolved = check.refs
      .map((ref) => ({ ref, info: ctx.revisionsByRef.get(ref) ?? null }))
      .filter((r): r is { ref: string; info: CheckRefInfo } => r.info != null);

    if (check.kind === 'same_material_refs') {
      const interpretation =
        '比较各 ref 版本化材料资产集合（material_id/kind/asset_id/digest/内联文本）是否完全相同';
      if (check.refs.length < 2) {
        results.push({
          ...unknownResult(
            check.id,
            check.claim,
            interpretation,
            check.refs,
            'same_material_refs 需要至少 2 个 ref',
            'record_lookup_and_compare',
          ),
        });
        continue;
      }
      if (badInCheck.length > 0 || resolved.length !== check.refs.length) {
        results.push(
          unknownResult(
            check.id,
            check.claim,
            interpretation,
            check.refs,
            `以下 ref 解析失败：${badInCheck.map((r) => `${r} (${ctx.badRefs.get(r)})`).join('; ')}`,
            'record_lookup_and_compare',
          ),
        );
        continue;
      }
      const signatures = resolved.map((r) => ({
        ref: r.ref,
        signature: r.info.materials.map(materialIdentity).sort().join('\n'),
        material_count: r.info.materials.length,
      }));
      const allSame = signatures.every((s) => s.signature === signatures[0].signature);
      results.push({
        id: check.id,
        ...(check.claim != null ? { claim: check.claim } : {}),
        interpretation,
        verdict: allSame ? 'supported' : 'contradicted',
        execution_status: 'completed',
        method: 'record_lookup_and_compare',
        inputs: check.refs,
        evidence: signatures.map((s) => ({
          ref: s.ref,
          material_signature: s.signature,
          material_count: s.material_count,
        })),
        steps: [
          {
            method: 'record_lookup_and_compare',
            input_refs: check.refs,
            operation:
              '读取各 ref 的 question_revision.structure.materials，按资产身份排序后逐字节比较集合',
          },
        ],
        limitations: [
          '窄事实：材料【资产身份】相同 ≠ 语义上「同一篇文章」——同一作品的不同摘录/版本会被判为不同集合',
        ],
      });
      continue;
    }

    if (check.kind === 'ref_state') {
      const params = (check.params ?? {}) as { assert?: unknown };
      const assert = params.assert === 'is_servable' ? 'is_servable' : 'is_current';
      const interpretation =
        assert === 'is_current'
          ? '每个 ref 是否仍指向其组的当前发布版本（lifecycle.current_revision_id）'
          : '每个 ref 是否当前版本且至少一个选定小题可自动判分发出（返回可服务 part_ids；不代表整组可发）';
      if (badInCheck.length > 0 || resolved.length !== check.refs.length) {
        results.push(
          unknownResult(
            check.id,
            check.claim,
            interpretation,
            check.refs,
            `以下 ref 解析失败：${badInCheck.map((r) => `${r} (${ctx.badRefs.get(r)})`).join('; ')}`,
            'record_lookup',
          ),
        );
        continue;
      }
      const selectedPartIds = check.params?.part_ids;
      if (
        selectedPartIds !== undefined &&
        (assert !== 'is_servable' ||
          check.refs.length !== 1 ||
          !Array.isArray(selectedPartIds) ||
          selectedPartIds.length === 0 ||
          selectedPartIds.some((id) => typeof id !== 'string' || id.length === 0))
      ) {
        results.push(
          unknownResult(
            check.id,
            check.claim,
            '检查指定小题的自动判分可用性',
            check.refs,
            'part_ids requires one ref, is_servable, and a nonempty string array',
            'record_lookup',
          ),
        );
        continue;
      }
      const evidence = resolved.map((r) => ({
        ref: r.ref,
        revision_id: r.info.revision_id,
        group_id: r.info.group_id,
        is_current: r.info.current,
        withdrawn: r.info.withdrawn,
        suspended: r.info.suspended,
        admission_state: r.info.admission_state,
        ...(assert === 'is_servable'
          ? { automatically_servable_part_ids: servable.get(r.info.group_id) ?? [] }
          : {}),
      }));
      const verdicts = resolved.map((r) =>
        assert === 'is_current'
          ? r.info.current
          : r.info.current &&
            !r.info.withdrawn &&
            !r.info.suspended &&
            r.info.admission_state === 'admitted' &&
            (selectedPartIds === undefined
              ? (servable.get(r.info.group_id)?.length ?? 0) > 0
              : (selectedPartIds as string[]).every((id) =>
                  servable.get(r.info.group_id)?.includes(id),
                )),
      );
      results.push({
        id: check.id,
        ...(check.claim != null ? { claim: check.claim } : {}),
        interpretation:
          selectedPartIds === undefined
            ? interpretation
            : '指定 ref 的每个 part_id 是否可自动判分发出（无关小题不阻塞）',
        verdict: verdicts.every(Boolean) ? 'supported' : 'contradicted',
        execution_status: 'completed',
        method: assert === 'is_current' ? 'record_lookup' : 'deterministic_recompute',
        inputs: check.refs,
        evidence,
        steps: [
          {
            method: assert === 'is_current' ? 'record_lookup' : 'deterministic_recompute',
            input_refs: check.refs,
            operation:
              assert === 'is_current'
                ? '比较 revision_id 与 question_group_lifecycle.current_revision_id'
                : '对每个选定小题复用正式发题只读 gate 验证 draft/availability/lifecycle 与冻结评分执行契约',
          },
        ],
        limitations: ['只描述这些 ref 的记录状态；不说明库中是否存在满足同一条件的其他题'],
      });
      continue;
    }

    if (check.kind === 'contract_valid') {
      const interpretation =
        '对每个 ref 的已存版本重跑发布期纯校验器（structure / response_spec / scoring_basis 三层，validateStructure/validateResponseSpec/validateScoringBasis）';
      if (badInCheck.length > 0 || resolved.length !== check.refs.length) {
        results.push(
          unknownResult(
            check.id,
            check.claim,
            interpretation,
            check.refs,
            `以下 ref 解析失败：${badInCheck.map((r) => `${r} (${ctx.badRefs.get(r)})`).join('; ')}`,
            'deterministic_recompute',
          ),
        );
        continue;
      }
      const evidence: Array<Record<string, unknown>> = [];
      let allValid = true;
      for (const r of resolved) {
        const structure = r.info.structure as Parameters<typeof validateStructure>[0];
        const spec = r.info.response_spec as Parameters<typeof validateResponseSpec>[0];
        const basis = r.info.scoring_basis as Parameters<typeof validateScoringBasis>[0];
        const issues = [
          ...validateStructure(structure),
          ...validateResponseSpec(spec, structure),
          ...validateScoringBasis(basis, spec, structure),
        ];
        if (issues.length > 0) allValid = false;
        evidence.push({
          ref: r.ref,
          issue_codes: issues.map((i) => i.code),
          issue_count: issues.length,
        });
      }
      results.push({
        id: check.id,
        ...(check.claim != null ? { claim: check.claim } : {}),
        interpretation,
        verdict: allValid ? 'supported' : 'contradicted',
        execution_status: 'completed',
        method: 'deterministic_recompute',
        inputs: check.refs,
        evidence,
        steps: [
          {
            method: 'deterministic_recompute',
            input_refs: check.refs,
            operation:
              '从 question_revision 行读回四层中的三层契约，重跑发布 barrier 的纯校验器并与零问题判定比较',
          },
        ],
        limitations: [
          '发布 seam 在写入时以插入序 JSON 计算 integrity_digest，jsonb 读回不保序，无法从行值重 derive 存量 digest——本检查用重跑校验器代替 digest 重算',
        ],
      });
      continue;
    }

    // material_assets_present
    const interpretation =
      '每个 ref 的共享材料是否全部在场：内联文本材料随版本持久化；二进制材料在 asset store 有行且 sha256 与版本 digest 一致';
    if (badInCheck.length > 0 || resolved.length !== check.refs.length) {
      results.push(
        unknownResult(
          check.id,
          check.claim,
          interpretation,
          check.refs,
          `以下 ref 解析失败：${badInCheck.map((r) => `${r} (${ctx.badRefs.get(r)})`).join('; ')}`,
          'record_lookup',
        ),
      );
      continue;
    }
    const evidence: Array<Record<string, unknown>> = [];
    let allPresent = true;
    for (const r of resolved) {
      const perMaterial = r.info.materials.map((m) => {
        if (m.content_md != null)
          return {
            material_id: m.material_id,
            kind: m.kind,
            present: true,
            digest_verified: null as boolean | null,
          };
        const sha = assetShaById.get(m.asset_id);
        const present = sha != null;
        const verified = sha != null ? bankAssetDigestMatches(sha, m.digest) : null;
        if (!present || verified === false) allPresent = false;
        return {
          material_id: m.material_id,
          kind: m.kind,
          asset_id: m.asset_id,
          present,
          digest_verified: verified,
        };
      });
      evidence.push({ ref: r.ref, materials: perMaterial });
    }
    results.push({
      id: check.id,
      ...(check.claim != null ? { claim: check.claim } : {}),
      interpretation,
      verdict: allPresent ? 'supported' : 'contradicted',
      execution_status: 'completed',
      method: 'record_lookup',
      inputs: check.refs,
      evidence,
      steps: [
        {
          method: 'record_lookup',
          input_refs: check.refs,
          operation:
            '读取 revision.structure.materials；内联文本看 content_md，二进制资产查 source_asset.sha256 与版本 digest 比较',
        },
      ],
      limitations: ['asset store 行的 sha256 是上传时记录值，不是对 blob 的现场重哈希'],
    });
  }

  return CheckBankOutputSchema.parse({
    checks: results,
    notes,
    supported_kinds: [...CHECK_BANK_KINDS],
  });
}

async function executeCheckBank(
  ctx: ToolContext,
  rawInput: CheckBankInput,
): Promise<CheckBankOutput> {
  return runCheckBank(ctx.db, rawInput);
}

export const checkBankTool: DomainTool<CheckBankInput, CheckBankOutput> = {
  name: 'check_bank',
  description:
    'Run DETERMINISTIC checks over explicitly specified bank refs (ADR-0072 D5; v1 has NO semantic/model checks — allow_model is accepted but enables nothing). Pick an explicit `kind`: same_material_refs (≥2 refs — versioned material asset sets identical? narrow fact: asset identity, NOT "same article" semantics) / ref_state (params.assert = is_current (default) | is_servable — the issuance gate for each part; optional params.part_ids selects a nonempty subset for one ref, otherwise reports whether any part is servable with its exact IDs) / contract_valid (re-runs the publish-time pure validators over the stored version) / material_assets_present (figures/materials present with sha256 matching the version digest). Free-text claims are echoed, never interpreted — if no kind matches your question the verdict is unknown with the supported-kind list. Each check reports verdict (supported/contradicted/unknown), method, input refs, evidence and limitations; checks answer only the specified refs, never "nothing else in the bank".',
  effect: 'read',
  inputSchema: CheckBankInputSchema,
  outputSchema: CheckBankOutputSchema,
  costClass: 'local',
  execute: executeCheckBank,
  summarize(_input, output) {
    const counts: Record<string, number> = {};
    for (const c of output.checks) {
      counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
    }
    const folded = Object.entries(counts)
      .map(([v, n]) => `${v}:${n}`)
      .join(' ');
    return `check_bank · ${output.checks.length} · ${folded}`;
  },
  mirrorEvent: 'never',
};
