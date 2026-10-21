// 统一发布 seam：工作副本编辑 → 原子发布。一次事务内写新 question_revision、
// lifecycle 指针/维度、发布事件 + identity diff；任一步失败整体回滚。
//
// group：单题 = 1-part 组（group_id = question.id）；composite part 的组 = 父 id。
// legacy question 行是工作副本，publisher 不重写其内容列。
//
// CAS 双令牌：expectedCurrentRevision 与 expectedAdmissionGeneration，禁止省略当
// 无条件覆盖。锁序 question 根 → lifecycle，组快照读在锁后。
//
// claim 与 lifecycle 分离：去重 claim 走 legacy canonical_content_hash 部分唯一
// 索引；lifecycle 只承载政策与挂起/撤回维度。
//
// admitted 必须带通过的 evidence；内容变更使旧 evidence 失效（折叠为 withheld）；
// 维度更新受 generation CAS 保护。

import { createHash } from 'node:crypto';

import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';

import type {
  AdmissionEvidenceT,
  CustomBlockT,
  ExecutionPlanT,
  PresentationBlockT,
  PresentationT,
  QuestionGroupStructureT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  CUSTOM_ASSET_MAX_BYTES,
  CUSTOM_ASSET_MIME_TYPES,
  DECLARED_BLANK_COMPARE_VERSION,
  Presentation,
  declaredBlankGradeReadiness,
  findCustomCodeForbiddenSequence,
  validateExecutionPlan,
  validatePresentation,
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '@/core/schema/assessment';
import {
  QUESTION_AVAILABILITY,
  SCORING_ADMISSION_STATE,
  SCORING_ADMISSION_WITHHELD_REASON,
} from '@/core/schema/assessment/lifecycle';
import type { Db, Tx } from '@/db/client';
import {
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
  source_asset,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resolveGroupContract } from './assessment-group-contract';
import {
  type NormalizedContract,
  type PartRow,
  type PublishedContractSeal,
  publishedContractSeal,
  publishedSealAccepts,
} from './assessment-normalization';

export const ASSESSMENT_PUBLISH_ACTION = 'experimental:assessment_publish' as const;

/** §3.3 withheld 原因（与 lifecycle CHECK 枚举一致）。 */
export type WithheldReason =
  | 'unverified_rules'
  | 'verification_failed'
  | 'no_admitted_executor'
  | 'owner_hold';

export interface PublishAdmission {
  state: 'admitted' | 'withheld';
  /** admitted 必填，且必须是通过的核验。 */
  evidence?: AdmissionEvidenceT | null;
  /** withheld 必填。 */
  reason?: WithheldReason;
}

/** suspension 维度；retraction_hold 不由 verify 路径清除。 */
export type SuspensionReason = 'verify_hold' | 'retraction_hold';

export interface SuspensionUpdate {
  suspended: boolean;
  /** suspended=true 必填。 */
  reason?: SuspensionReason;
}

/** 发布事务内追加的 append-only 核验记录。 */
export interface AdmissionVerificationWrite {
  /** 调用方命名空间的 policy 标识。 */
  policy_id: string;
  /** failed 只记录证据，不改变 admission 决定。 */
  outcome: 'passed' | 'suspended' | 'failed';
  /** 核验摘要证据。 */
  evidence?: Record<string, unknown>;
}

/** 发布输入：契约四层由 contract-normalizer 产出（此处只收成品）。 */
export interface PublishQuestionGroupInput {
  group_id: string;
  contract: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
    execution_plan: ExecutionPlanT;
    /** 冻结展示层；过同一 barrier 并计入 digest，缺省时旧 digest 不变。 */
    presentation?: PresentationT;
    integrity_digest: string;
  };
  /** REQUIRED null-or-id CAS：null = 期望尚无发布；id = 期望替换的当前版本。 */
  expectedCurrentRevision: string | null;
  /** REQUIRED generation CAS；null = 期望 lifecycle 尚不存在。 */
  expectedAdmissionGeneration: number | null;
  availability: 'general_pool' | 'container_only';
  admission: PublishAdmission;
  actorRef: string;
  claimPolicy?: 'one_time' | 'unbounded';
  /** 缺省不变；解除只清 verify_hold。独立版本化维度，变化时 generation+1。 */
  suspension?: SuspensionUpdate;
  /** 随发布追加的 verify 记录；conflict/withdrawn 不写。 */
  verification?: AdmissionVerificationWrite;
  /** 发布者 provenance（jsonb published_by；缺省 NULL）。 */
  publishedBy?: unknown;
  /**
   * 自定义块字节核验的读取器；kernel 不依赖存储层，由组合方注入。含 custom
   * 块时必供，缺省 fail-closed。
   */
  readAssetBytes?: (storageKey: string) => Promise<Uint8Array | null>;
  now: Date;
}

export type PublishQuestionGroupResult =
  | {
      status: 'published';
      revision_id: string;
      revision_ordinal: number;
      group_id: string;
      event_id: string;
      admission_generation: number;
      /** 新 revision 的 integrity_digest（verify 记录用）。 */
      revision_digest: string;
    }
  | {
      /** 内容未变但维度变了：只更新 lifecycle（generation+1）+ 事件。 */
      status: 'admission_updated';
      group_id: string;
      current_revision_id: string;
      admission_generation: number;
      /** 当前 revision 的 integrity_digest（verify 记录用）。 */
      revision_digest: string;
      event_id: string;
    }
  | {
      /** 全部子 part tombstone：不铸空 revision，只落撤回维度。 */
      status: 'withdrawn';
      group_id: string;
    }
  | {
      status: 'noop';
      group_id: string;
      current_revision_id: string;
      reason: 'digest_unchanged';
      /** 当前 revision digest + 当前 admission generation（verify 记录用）。 */
      revision_digest: string;
      admission_generation: number;
    }
  | {
      status: 'conflict';
      group_id: string;
      current_revision_id: string | null;
      reason: 'revision_cas' | 'admission_generation_cas';
    };

function assertAdmissionShape(admission: PublishAdmission): void {
  if (admission.state === 'admitted') {
    const evidence = admission.evidence;
    if (evidence == null) {
      throw new Error('publishQuestionGroup: admitted requires evidence (D1 dual-gate)');
    }
    // 失败的核验不是准入证据。
    if (evidence.verification.structural_check_passed !== true) {
      throw new Error(
        'publishQuestionGroup: admitted evidence must have structural_check_passed=true',
      );
    }
    const independent = evidence.verification.independent_verification;
    if (independent != null && independent.passed !== true) {
      throw new Error(
        'publishQuestionGroup: admitted evidence must carry a PASSED independent verification (D1)',
      );
    }
    return;
  }
  if (admission.reason == null) {
    throw new Error('publishQuestionGroup: withheld requires a reason (lifecycle branch CHECK)');
  }
}

function assertSuspensionShape(suspension: SuspensionUpdate): void {
  if (suspension.suspended && suspension.reason == null) {
    throw new Error('publishQuestionGroup: suspended=true requires a reason (lifecycle CHECK)');
  }
}

/** 递归收集 presentation 里的自定义块（spec §1.3 —— DB 资产核验的输入）。 */
function collectCustomBlocks(block: PresentationBlockT): CustomBlockT[] {
  if (block.kind === 'stack' || block.kind === 'passage_layout') {
    return block.children.flatMap(collectCustomBlocks);
  }
  return block.kind === 'custom' ? [block] : [];
}

/**
 * 自定义块资产核验：行存在、digest/mime/size 合规、实测字节 sha256 与行一致、
 * 无禁序；任一失败拒发。
 */
async function assertCustomBlockAssets(
  tx: Tx,
  presentation: PresentationT,
  readAssetBytes: ((storageKey: string) => Promise<Uint8Array | null>) | undefined,
): Promise<void> {
  const customBlocks = collectCustomBlocks(presentation.root);
  if (customBlocks.length === 0) return;
  if (readAssetBytes == null) {
    throw new Error(
      'publishQuestionGroup: presentation has custom blocks but no readAssetBytes reader was supplied — code cannot be verified, refusing to publish',
    );
  }
  const assetIds = [...new Set(customBlocks.map((block) => block.sandbox.asset.asset_id))];
  const assetRows = await tx
    .select({
      id: source_asset.id,
      sha256: source_asset.sha256,
      mime_type: source_asset.mime_type,
      byte_size: source_asset.byte_size,
      storage_key: source_asset.storage_key,
    })
    .from(source_asset)
    .where(inArray(source_asset.id, assetIds));
  const assetById = new Map(assetRows.map((row) => [row.id, row] as const));
  const textDecoder = new TextDecoder();
  for (const block of customBlocks) {
    const { asset_id, digest } = block.sandbox.asset;
    const asset = assetById.get(asset_id);
    if (asset == null) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' references unknown source_asset '${asset_id}'`,
      );
    }
    if (`sha256:${asset.sha256}` !== digest) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' digest '${digest}' does not match source_asset '${asset_id}' sha256 '${asset.sha256}'`,
      );
    }
    if (!(CUSTOM_ASSET_MIME_TYPES as readonly string[]).includes(asset.mime_type)) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' source_asset '${asset_id}' mime_type '${asset.mime_type}' is not ${CUSTOM_ASSET_MIME_TYPES.join(' or ')}`,
      );
    }
    if (asset.byte_size > CUSTOM_ASSET_MAX_BYTES) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' source_asset '${asset_id}' byte_size ${asset.byte_size} exceeds the ${CUSTOM_ASSET_MAX_BYTES}-byte (256 KiB) limit`,
      );
    }
    // 字节级核验：实测 sha256 与资产行一致，再扫禁序。
    const bytes = await readAssetBytes(asset.storage_key);
    if (bytes == null) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' source_asset '${asset_id}' bytes missing from storage (key '${asset.storage_key}')`,
      );
    }
    // 实际长度必须等于登记的 byte_size；上限也按登记值判断。
    if (bytes.byteLength !== asset.byte_size) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' source_asset '${asset_id}' stored object is ${bytes.byteLength} bytes, not the recorded byte_size ${asset.byte_size}`,
      );
    }
    const measuredSha256 = createHash('sha256').update(bytes).digest('hex');
    if (measuredSha256 !== asset.sha256) {
      throw new Error(
        `publishQuestionGroup: custom block '${block.block_id}' source_asset '${asset_id}' bytes hash to sha256:${measuredSha256}, not the recorded '${asset.sha256}' — id/bytes binding is broken`,
      );
    }
    const forbidden = findCustomCodeForbiddenSequence(textDecoder.decode(bytes));
    if (forbidden != null) {
      throw new Error(
        `publishQuestionGroup: custom_code_forbidden_sequence: custom block '${block.block_id}' code contains '${forbidden.sequence}' at byte offset ${forbidden.index} — refusing to publish`,
      );
    }
  }
}

/**
 * suspension 更新 → lifecycle 列值；null 表示对当前 lifecycle 无效果。
 * verify_hold 不得遮蔽 retraction_hold，解除也只清 verify_hold。
 */
function suspensionValuesFor(
  lifecycle: typeof question_group_lifecycle.$inferSelect | undefined,
  suspension: SuspensionUpdate | undefined,
): { suspended: boolean; suspension_reason: SuspensionReason | null } | null {
  if (suspension == null) return null;
  if (suspension.suspended) {
    const reason = suspension.reason ?? 'verify_hold';
    if (
      reason === 'verify_hold' &&
      lifecycle?.suspended === true &&
      lifecycle.suspension_reason === 'retraction_hold'
    ) {
      return { suspended: true, suspension_reason: 'retraction_hold' };
    }
    return { suspended: true, suspension_reason: reason };
  }
  // 只清 verify_hold；retraction_hold 恒保留。
  if (lifecycle?.suspension_reason !== 'verify_hold') return null;
  return { suspended: false, suspension_reason: null };
}

/** 确定性序列化：jsonb 键序不稳定，维度比对必须与顺序无关。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** §3.3 维度是否与当前 lifecycle 完全一致（一致 ⇒ 真 noop；不一致 ⇒ 只更新维度）。 */
function lifecycleDimensionsMatch(
  lifecycle: typeof question_group_lifecycle.$inferSelect | undefined,
  input: PublishQuestionGroupInput,
): boolean {
  if (!lifecycle) return false;
  if (input.availability !== lifecycle.availability) return false;
  if (input.claimPolicy != null && input.claimPolicy !== lifecycle.claim_policy) return false;

  const nextSuspension = suspensionValuesFor(lifecycle, input.suspension);
  if (nextSuspension != null) {
    if (
      nextSuspension.suspended !== lifecycle.suspended ||
      nextSuspension.suspension_reason !== (lifecycle.suspension_reason ?? null)
    ) {
      return false;
    }
  }
  if (input.admission.state === 'admitted') {
    return (
      lifecycle.scoring_admission_state === SCORING_ADMISSION_STATE.ADMITTED &&
      stableStringify(input.admission.evidence ?? null) ===
        stableStringify(lifecycle.scoring_admission_evidence ?? null)
    );
  }
  return (
    lifecycle.scoring_admission_state === SCORING_ADMISSION_STATE.WITHHELD &&
    lifecycle.scoring_admission_withheld_reason === input.admission.reason
  );
}

function admissionValuesFor(admission: PublishAdmission, now: Date) {
  return admission.state === 'admitted'
    ? {
        scoring_admission_state: 'admitted' as const,
        scoring_admission_evidence: admission.evidence ?? null,
        scoring_admission_withheld_reason: null,
        scoring_admission_decided_at: now,
      }
    : {
        scoring_admission_state: 'withheld' as const,
        scoring_admission_evidence: null,
        scoring_admission_withheld_reason: admission.reason ?? 'owner_hold',
        scoring_admission_decided_at: null,
      };
}

/** 语义 identity diff：part id 相同不代表语义连续；内容变化记 replaced 并保留
 * old→new fingerprint，无法判定也记 replaced。 */
export interface PartChange {
  part_id: string;
  status: 'retained' | 'replaced' | 'added' | 'removed';
}

export interface ReplacementMapping {
  part_id: string;
  previous_fingerprint: string;
  next_fingerprint: string;
}

export interface IdentityDiff {
  part_changes: PartChange[];
  /** slot 级 option 增删（option 文本变 ⇒ 新身份 = 语义替换；label 不参与身份）。 */
  option_changes: { slot_id: string; added_option_ids: string[]; removed_option_ids: string[] }[];
  /** replaced part 的 old→new 判分内容 fingerprint。 */
  replacement_mappings: ReplacementMapping[];
}

/** 题面 + 材料 + 选项文本 + criterion；变化即语义替换。 */
function partFingerprint(
  partId: string,
  structure: QuestionGroupStructureT,
  spec: ResponseSpecT,
  basis: ScoringBasisT,
): string | null {
  const part = structure.parts.find((p) => p.part_id === partId);
  if (part == null) return null;
  const slot = spec.slots.find((s) => s.part_id === partId);
  const unit = basis.units.find((u) => u.scoring_unit_id === `${partId}::u`);
  if (slot == null || unit == null) return null; // 形状异常 ⇒ 无法判定
  const options =
    slot.kind === 'single_choice' || slot.kind === 'multi_choice'
      ? slot.options.map((o) => `${o.option_id}:${o.text}`).sort()
      : [];
  const canonical = stableStringify({
    prompt: part.prompt_md,
    material_ids: [...part.material_ids].sort(),
    options,
    criterion: unit.criterion,
  });
  return `fp_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/** 与被替换版本比对，产出语义 identity diff。 */
function computeIdentityDiff(
  previous: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
  } | null,
  next: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
  },
): IdentityDiff {
  const optionChangesFor = (prev: ResponseSpecT | null): IdentityDiff['option_changes'] => {
    const prevOptionsBySlot = new Map(
      (prev?.slots ?? []).flatMap((slot) =>
        slot.kind === 'single_choice' || slot.kind === 'multi_choice'
          ? [[slot.slot_id, new Set(slot.options.map((o) => o.option_id))] as const]
          : [],
      ),
    );
    const changes: IdentityDiff['option_changes'] = [];
    for (const slot of next.response_spec.slots) {
      if (slot.kind !== 'single_choice' && slot.kind !== 'multi_choice') continue;
      const prevOpts = prevOptionsBySlot.get(slot.slot_id) ?? new Set<string>();
      const current = slot.options.map((o) => o.option_id);
      const added = current.filter((id) => !prevOpts.has(id));
      const removed = [...prevOpts].filter((id) => !current.includes(id));
      if (added.length > 0 || removed.length > 0) {
        changes.push({
          slot_id: slot.slot_id,
          added_option_ids: added,
          removed_option_ids: removed,
        });
      }
    }
    return changes;
  };

  if (previous == null) {
    return {
      part_changes: next.structure.parts.map((p) => ({
        part_id: p.part_id,
        status: 'added' as const,
      })),
      option_changes: optionChangesFor(null),
      replacement_mappings: [],
    };
  }
  const prevParts = new Set(previous.structure.parts.map((p) => p.part_id));
  const nextParts = new Set(next.structure.parts.map((p) => p.part_id));
  const partChanges: PartChange[] = [];
  const replacementMappings: ReplacementMapping[] = [];
  for (const partId of nextParts) {
    if (!prevParts.has(partId)) {
      partChanges.push({ part_id: partId, status: 'added' });
      continue;
    }
    const prevFp = partFingerprint(
      partId,
      previous.structure,
      previous.response_spec,
      previous.scoring_basis,
    );
    const nextFp = partFingerprint(partId, next.structure, next.response_spec, next.scoring_basis);
    // fingerprint 不可得或内容变化 ⇒ replaced。
    if (prevFp != null && nextFp != null && prevFp === nextFp) {
      partChanges.push({ part_id: partId, status: 'retained' });
    } else {
      partChanges.push({ part_id: partId, status: 'replaced' });
      replacementMappings.push({
        part_id: partId,
        previous_fingerprint: prevFp ?? 'unrecoverable',
        next_fingerprint: nextFp ?? 'unrecoverable',
      });
    }
  }
  for (const partId of prevParts) {
    if (!nextParts.has(partId)) partChanges.push({ part_id: partId, status: 'removed' });
  }
  return {
    part_changes: partChanges,
    option_changes: optionChangesFor(previous.response_spec),
    replacement_mappings: replacementMappings,
  };
}

function sameSealedDocument(
  stored: {
    digest: string;
    structure: unknown;
    response_spec: unknown;
    scoring_basis: unknown;
    execution_plan: unknown;
    presentation: unknown;
  },
  incoming: PublishedContractSeal,
  suppliedDigest: string,
  suppliedAccepted: boolean,
): boolean {
  // A digest sent back verbatim may not recompute from jsonb key order; the same
  // string that still seals the incoming layers is the same document.
  if (suppliedDigest === stored.digest && suppliedAccepted) return true;
  let storedSeal: PublishedContractSeal;
  try {
    storedSeal = publishedContractSeal({
      structure: stored.structure,
      response_spec: stored.response_spec,
      scoring_basis: stored.scoring_basis,
      execution_plan: stored.execution_plan,
      ...(stored.presentation != null ? { presentation: stored.presentation } : {}),
    });
  } catch {
    return false;
  }
  if (storedSeal.canonical !== incoming.canonical) return false;
  if (!publishedSealAccepts(storedSeal, stored.digest)) return false;
  return suppliedAccepted;
}

async function publishedLayersChanged(
  tx: Tx,
  revisionId: string,
  incoming: {
    integrity_digest: string;
    structure: unknown;
    response_spec: unknown;
    scoring_basis: unknown;
    execution_plan: unknown;
    presentation?: unknown;
  },
): Promise<boolean> {
  const [stored] = await tx
    .select({
      digest: question_revision.integrity_digest,
      structure: question_revision.structure,
      response_spec: question_revision.response_spec,
      scoring_basis: question_revision.scoring_basis,
      execution_plan: question_revision.execution_plan,
      presentation: question_revision.presentation,
    })
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId))
    .limit(1);
  if (stored == null || stored.digest === incoming.integrity_digest) return stored == null;
  try {
    const storedSeal = publishedContractSeal({
      structure: stored.structure,
      response_spec: stored.response_spec,
      scoring_basis: stored.scoring_basis,
      execution_plan: stored.execution_plan,
      ...(stored.presentation != null ? { presentation: stored.presentation } : {}),
    });
    const incomingSeal = publishedContractSeal({
      structure: incoming.structure,
      response_spec: incoming.response_spec,
      scoring_basis: incoming.scoring_basis,
      execution_plan: incoming.execution_plan,
      ...(incoming.presentation != null ? { presentation: incoming.presentation } : {}),
    });
    return storedSeal.canonical !== incomingSeal.canonical;
  } catch {
    return true;
  }
}

/**
 * 统一发布 seam。Db 自开事务，Tx 用 SAVEPOINT。契约校验 fail-closed；CAS 冲突
 * 返回 conflict；内容与维度都一致返回 noop；仅维度变化返回 admission_updated。
 * 新 revision 写规范封印；旧摘要只在仍能封住同一层时被接受。
 */
export async function publishQuestionGroup(
  db: Db | Tx,
  input: PublishQuestionGroupInput,
): Promise<PublishQuestionGroupResult> {
  assertAdmissionShape(input.admission);
  if (input.suspension != null) assertSuspensionShape(input.suspension);

  // 声明了 answer_shape 的 blank 必须通过共享判分就绪检查；只能以 withheld 发布，
  // 绝不回退普通 exact。blank_order 是展示语义，不拦。
  const declaredShapeSlot = input.contract.response_spec.slots.find(
    (slot) => slot.kind === 'blank' && slot.answer_shape != null,
  );
  if (
    declaredShapeSlot != null &&
    declaredShapeSlot.kind === 'blank' &&
    input.admission.state === 'admitted'
  ) {
    const readiness = declaredBlankGradeReadiness(
      input.contract.response_spec,
      input.contract.scoring_basis,
    );
    if (!readiness.ok) {
      throw new Error(
        `publishQuestionGroup: declared answer_shape not gradable — ${readiness.reason} (comparator ${DECLARED_BLANK_COMPARE_VERSION}) — publish the group as withheld; refusing to admit plain-exact auto-grading for a declared blank`,
      );
    }
  }

  // Db → 顶层事务；Tx → SAVEPOINT；任一步失败都回滚本次发布的全部写入。
  return db.transaction(async (tx) => {
    const { contract, group_id: groupId } = input;

    if (contract.structure.group_id !== groupId) {
      throw new Error(
        `publishQuestionGroup: contract structure.group_id '${contract.structure.group_id}' != target group '${groupId}'`,
      );
    }

    const structureIssues = validateStructure(contract.structure);
    if (structureIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: structure invalid: ${structureIssues.map((i) => i.code).join(',')}`,
      );
    }
    const specIssues = validateResponseSpec(contract.response_spec, contract.structure);
    if (specIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: response_spec invalid: ${specIssues.map((i) => i.code).join(',')}`,
      );
    }
    const basisIssues = validateScoringBasis(
      contract.scoring_basis,
      contract.response_spec,
      contract.structure,
    );
    if (basisIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: scoring_basis invalid: ${basisIssues.map((i) => i.code).join(',')}`,
      );
    }
    const planIssues = validateExecutionPlan(
      contract.execution_plan,
      contract.scoring_basis,
    ).filter(
      (issue) =>
        !(issue.code === 'unadmitted_model_executor' && input.admission.state === 'withheld'),
    );
    if (planIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: execution_plan invalid: ${planIssues.map((i) => i.code).join(',')}`,
      );
    }
    // 展示层走同一 barrier；入库与 digest 都用解析后的对象，digest 不符即拒发。
    let shapedPresentation: PresentationT | null = null;
    if (contract.presentation != null) {
      const shaped = Presentation.safeParse(contract.presentation);
      if (!shaped.success) {
        throw new Error(
          `publishQuestionGroup: presentation malformed: ${shaped.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.')}:${issue.message}`)
            .join('; ')}`,
        );
      }
      const presentationIssues = validatePresentation(
        shaped.data,
        contract.structure,
        contract.response_spec,
        contract.scoring_basis,
      );
      if (presentationIssues.length > 0) {
        throw new Error(
          `publishQuestionGroup: presentation invalid: ${presentationIssues
            .map((issue) => `${issue.code}(${issue.detail})`)
            .join('; ')}`,
        );
      }
      shapedPresentation = shaped.data;
      // 自定义块资产核验同 barrier、同事务；任一失败整组不能发布。
      await assertCustomBlockAssets(tx, shaped.data, input.readAssetBytes);
    }

    let seal: PublishedContractSeal;
    let suppliedAccepted: boolean;
    try {
      const rawSeal = publishedContractSeal(contract);
      seal =
        shapedPresentation == null
          ? rawSeal
          : publishedContractSeal({ ...contract, presentation: shapedPresentation });
      suppliedAccepted =
        publishedSealAccepts(seal, contract.integrity_digest) ||
        publishedSealAccepts(rawSeal, contract.integrity_digest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `publishQuestionGroup: contract layers do not match the published schema: ${detail}`,
      );
    }
    const integrityDigest = seal.canonical;

    // 发布与编辑共用 question → lifecycle 锁序。
    const [root] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, groupId))
      .for('update')
      .limit(1);
    if (!root) {
      throw new Error(`publishQuestionGroup: root question row '${groupId}' not found`);
    }

    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, groupId))
      .for('update')
      .limit(1);
    const currentRevisionId = lifecycle?.current_revision_id ?? null;

    // CAS（REQUIRED null-or-id / null-or-number —— 与调用方期望不符即冲突，不静默覆盖）。
    if (input.expectedCurrentRevision !== currentRevisionId) {
      return {
        status: 'conflict',
        group_id: groupId,
        current_revision_id: currentRevisionId,
        reason: 'revision_cas',
      };
    }
    const currentGeneration = lifecycle?.scoring_admission_generation ?? null;
    if (lifecycle != null && input.expectedAdmissionGeneration !== currentGeneration) {
      return {
        status: 'conflict',
        group_id: groupId,
        current_revision_id: currentRevisionId,
        reason: 'admission_generation_cas',
      };
    }

    let previousContract: {
      structure: QuestionGroupStructureT;
      response_spec: ResponseSpecT;
      scoring_basis: ScoringBasisT;
      ordinal: number;
      digest: string;
    } | null = null;

    // 内容一致不铸新版本；维度独立版本化，变化时只更新 lifecycle + 事件。
    let nextOrdinal = 1;
    if (currentRevisionId == null && !suppliedAccepted) {
      throw new Error(
        `publishQuestionGroup: integrity_digest mismatch (supplied ${contract.integrity_digest}, canonical ${seal.canonical}) — regenerate the contract via contract-normalizer`,
      );
    }
    if (currentRevisionId != null) {
      const [current] = await tx
        .select({
          ordinal: question_revision.revision_ordinal,
          digest: question_revision.integrity_digest,
          structure: question_revision.structure,
          response_spec: question_revision.response_spec,
          scoring_basis: question_revision.scoring_basis,
          execution_plan: question_revision.execution_plan,
          presentation: question_revision.presentation,
        })
        .from(question_revision)
        .where(eq(question_revision.revision_id, currentRevisionId))
        .limit(1);
      if (current != null) {
        previousContract = {
          structure: current.structure,
          response_spec: current.response_spec,
          scoring_basis: current.scoring_basis,
          ordinal: current.ordinal,
          digest: current.digest,
        };
      }
      const sameDocument =
        current != null &&
        sameSealedDocument(current, seal, contract.integrity_digest, suppliedAccepted);
      if (!suppliedAccepted && !sameDocument) {
        throw new Error(
          `publishQuestionGroup: integrity_digest mismatch (supplied ${contract.integrity_digest}, canonical ${seal.canonical}) — regenerate the contract via contract-normalizer`,
        );
      }
      if (current != null && sameDocument) {
        if (lifecycleDimensionsMatch(lifecycle, input)) {
          const noopResult = {
            status: 'noop' as const,
            group_id: groupId,
            current_revision_id: currentRevisionId,
            reason: 'digest_unchanged' as const,
            revision_digest: current.digest,
            admission_generation: currentGeneration ?? 0,
          };
          await insertAdmissionVerification(
            tx,
            input,
            currentRevisionId,
            current.digest,
            currentGeneration ?? 0,
          );
          return noopResult;
        }
        const admissionGeneration = lifecycle.scoring_admission_generation + 1;
        const suspensionValues = suspensionValuesFor(lifecycle, input.suspension);
        await tx
          .update(question_group_lifecycle)
          .set({
            availability: input.availability,
            ...admissionValuesFor(input.admission, input.now),
            scoring_admission_generation: admissionGeneration,
            ...(suspensionValues ?? {}),
            ...(input.claimPolicy ? { claim_policy: input.claimPolicy } : {}),
            updated_at: input.now,
          })
          .where(eq(question_group_lifecycle.group_id, groupId));
        const dimensionEventId = createId();
        await writeEvent(tx, {
          id: dimensionEventId,
          session_id: null,
          actor_kind: 'system',
          actor_ref: input.actorRef,
          action: ASSESSMENT_PUBLISH_ACTION,
          subject_kind: 'question',
          subject_id: groupId,
          outcome: 'success',
          payload: {
            group_id: groupId,
            revision_id: currentRevisionId,
            dimension_update: true,
            availability: input.availability,
            admission: input.admission.state,
            admission_generation: admissionGeneration,
            // 输入缺省 ⇒ 未变，不投影。
            ...(input.suspension != null
              ? {
                  suspended: suspensionValues?.suspended ?? lifecycle.suspended,
                  suspension_reason:
                    suspensionValues !== null
                      ? suspensionValues.suspension_reason
                      : (lifecycle.suspension_reason ?? null),
                }
              : {}),
            // 事件只带指针，证据本体在 verification 行。
            ...(input.verification != null
              ? {
                  verification: {
                    policy_id: input.verification.policy_id,
                    outcome: input.verification.outcome,
                  },
                }
              : {}),
          },
          created_at: input.now,
        });
        await insertAdmissionVerification(
          tx,
          input,
          currentRevisionId,
          current.digest,
          admissionGeneration,
        );
        return {
          status: 'admission_updated',
          group_id: groupId,
          current_revision_id: currentRevisionId,
          admission_generation: admissionGeneration,
          revision_digest: current.digest,
          event_id: dimensionEventId,
        };
      }
      nextOrdinal = (current?.ordinal ?? 0) + 1;
    }

    const revisionId = createId();
    await tx.insert(question_revision).values({
      revision_id: revisionId,
      group_id: groupId,
      revision_ordinal: nextOrdinal,
      integrity_digest: integrityDigest,
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,

      presentation: shapedPresentation ?? null,
      supersedes_revision_id: currentRevisionId,
      availability: input.availability,
      published_by: (input.publishedBy as never) ?? null,
      published_at: input.now,
    });

    const admissionGeneration = (lifecycle?.scoring_admission_generation ?? 0) + 1;
    const admissionValues = admissionValuesFor(input.admission, input.now);
    const suspensionValues = suspensionValuesFor(lifecycle, input.suspension);

    if (lifecycle) {
      await tx
        .update(question_group_lifecycle)
        .set({
          current_revision_id: revisionId,
          availability: input.availability,
          ...admissionValues,
          scoring_admission_generation: admissionGeneration,
          ...(suspensionValues ?? {}),
          ...(input.claimPolicy ? { claim_policy: input.claimPolicy } : {}),
          updated_at: input.now,
        })
        .where(eq(question_group_lifecycle.group_id, groupId));
    } else {
      await tx.insert(question_group_lifecycle).values({
        group_id: groupId,
        current_revision_id: revisionId,
        availability: input.availability,
        ...admissionValues,
        scoring_admission_generation: admissionGeneration,
        claim_policy: input.claimPolicy ?? 'unbounded',
        // 首版发布也可携带 suspension。
        ...(suspensionValues ?? { suspended: false, suspension_reason: null }),
        withdrawn: false,
        withdrawn_at: null,
        created_at: input.now,
        updated_at: input.now,
      });
    }

    // 同事务发布事件 + identity diff。
    const identityDiff = computeIdentityDiff(previousContract, contract);
    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'system',
      actor_ref: input.actorRef,
      action: ASSESSMENT_PUBLISH_ACTION,
      subject_kind: 'question',
      subject_id: groupId,
      outcome: 'success',
      payload: {
        group_id: groupId,
        revision_id: revisionId,
        revision_ordinal: nextOrdinal,
        supersedes_revision_id: currentRevisionId,
        integrity_digest: integrityDigest,
        availability: input.availability,
        admission: input.admission.state,
        admission_generation: admissionGeneration,
        ...(input.suspension != null
          ? {
              suspended: suspensionValues?.suspended ?? lifecycle?.suspended ?? false,
              suspension_reason:
                suspensionValues != null
                  ? suspensionValues.suspension_reason
                  : (lifecycle?.suspension_reason ?? null),
            }
          : {}),
        // 事件只带指针，证据本体在 verification 行。
        ...(input.verification != null
          ? {
              verification: {
                policy_id: input.verification.policy_id,
                outcome: input.verification.outcome,
              },
            }
          : {}),
        identity_changes: identityDiff,
      },
      created_at: input.now,
    });

    await insertAdmissionVerification(tx, input, revisionId, integrityDigest, admissionGeneration);

    return {
      status: 'published',
      revision_id: revisionId,
      revision_ordinal: nextOrdinal,
      group_id: groupId,
      event_id: eventId,
      admission_generation: admissionGeneration,
      revision_digest: integrityDigest,
    };
  });
}

export interface QuestionGroupContractSnapshot {
  rootId: string;
  root: typeof question.$inferSelect;
  /** 全部物理 part（含 tombstone —— 供 publisher 的撤回判定）。 */
  partRows: PartRow[];
  /** 排除 archived/dismissed 的可服务 part（契约成员）。 */
  liveParts: PartRow[];
  /** 当前 revision 携带答案声明时非空；contract 是冻结四层，不能从 flat 行重建。 */
  declaredRevisionId: string | null;
  contract: NormalizedContract;
}

/**
 * 组根 + parts + figure digest → 契约的唯一加载口；所有准入/发布读者必须看到同一
 * digest。lockRoot 缺省 true；已持锁或接受后续 drift check 时传 false。
 */
export async function loadQuestionGroupContractSnapshot(
  db: Db | Tx,
  rootId: string,
  opts?: { lockRoot?: boolean },
): Promise<QuestionGroupContractSnapshot> {
  const rootSelect = db.select().from(question).where(eq(question.id, rootId));
  const root = (
    await (opts?.lockRoot === false ? rootSelect.limit(1) : rootSelect.for('update').limit(1))
  )[0];
  if (!root) {
    throw new Error(`loadQuestionGroupContractSnapshot: group root question '${rootId}' not found`);
  }
  // Tombstoned parts are not group members; their archive changes group content.
  const partRows = await db
    .select({
      id: question.id,
      kind: question.kind,
      judge_kind_override: question.judge_kind_override,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      structured: question.structured,
      figures: question.figures,
      metadata: question.metadata,
    })
    .from(question)
    .where(eq(question.parent_question_id, root.id))
    .orderBy(question.part_index);

  const liveParts = partRows.filter((p) => {
    const meta = p.metadata as Record<string, unknown> | null;
    return meta?.archived_at == null && meta?.dismissed_at == null;
  });

  const { declaredRevisionId, contract } = await resolveGroupContract(db, root, liveParts);
  return { rootId: root.id, root, partRows, liveParts, declaredRevisionId, contract };
}

export interface PublishFromRowInput {
  /** 组根 question id（单题 = 自身；part 编辑时传父 id）。 */
  rootId: string;
  /** 缺省 preserve：内容未变沿用当前 admission，内容变更折叠为 withheld。 */
  admission?: PublishAdmission | { state: 'preserve' };
  availability?: 'general_pool' | 'container_only';
  /** suspension 维度；缺省不改变。 */
  suspension?: SuspensionUpdate;
  /** 随发布事务追加的 verify 记录。 */
  verification?: AdmissionVerificationWrite;
  /** 缺省不改；首次发布时 'unbounded'。 */
  claimPolicy?: 'one_time' | 'unbounded';
  /** 透传给 publishQuestionGroup；含 custom 块时必供。 */
  readAssetBytes?: (storageKey: string) => Promise<Uint8Array | null>;
  actorRef: string;
  now: Date;
}

/**
 * 加载 → 归一 → 发布。先锁组根再读快照，CAS 取自锁后值；conflict 直接抛错回滚。
 * 未决转换强制 withheld，绝不放宽调用方更严的决定。
 */
export async function publishQuestionGroupFromRow(
  db: Db | Tx,
  input: PublishFromRowInput,
): Promise<PublishQuestionGroupResult> {
  return db.transaction(async (tx) => {
    // Resolve the real root before locking: never lock a child then its parent.
    const supplied = (
      await tx
        .select({ id: question.id, parentId: question.parent_question_id })
        .from(question)
        .where(eq(question.id, input.rootId))
        .limit(1)
    )[0];
    if (!supplied) {
      throw new Error(`publishQuestionGroupFromRow: root question '${input.rootId}' not found`);
    }
    const effectiveRootId = supplied.parentId ?? supplied.id;

    const snapshot = await loadQuestionGroupContractSnapshot(tx, effectiveRootId);
    const { rootId, root, partRows, liveParts, contract } = snapshot;

    // 声明题不能从 flat 行重建（会掉声明）：显式冲突并回滚同事务，调用方改走
    // typed 编辑/发布。
    if (snapshot.declaredRevisionId != null) {
      throw new Error(
        `publishQuestionGroupFromRow: group '${rootId}' current revision '${snapshot.declaredRevisionId}' carries YUK-1568 answer declarations (answer_shape/blank_order) — republishing from legacy rows would drop them; edit via edit_question + submit_question instead (row-path migration tracked in YUK-1568 slice 3)`,
      );
    }

    // 全部子 part tombstone：不铸空 revision，只落撤回维度。
    if (partRows.length > 0 && liveParts.length === 0) {
      await archiveGroupLifecycle(tx, rootId, input.now);
      return { status: 'withdrawn', group_id: rootId } satisfies PublishQuestionGroupResult;
    }

    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, rootId))
      .for('update')
      .limit(1);
    const expectedRevision = lifecycle?.current_revision_id ?? null;
    const expectedGeneration = lifecycle?.scoring_admission_generation ?? null;

    const contentChanged =
      expectedRevision == null ||
      lifecycle == null ||
      (await publishedLayersChanged(tx, expectedRevision, contract));

    // preserve + 内容变更 ⇒ withheld（旧 evidence 不越代）；内容未变沿用当前
    // 维度；未决转换强制 withheld。
    let admission: PublishAdmission;
    if (input.admission != null && input.admission.state !== 'preserve') {
      admission = input.admission;
    } else if (contentChanged) {
      admission = {
        state: 'withheld',
        reason:
          lifecycle?.scoring_admission_state === SCORING_ADMISSION_STATE.WITHHELD
            ? ((lifecycle.scoring_admission_withheld_reason ??
                SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES) as WithheldReason)
            : SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
      };
    } else if (lifecycle?.scoring_admission_state === SCORING_ADMISSION_STATE.ADMITTED) {
      admission = { state: 'admitted', evidence: lifecycle.scoring_admission_evidence ?? null };
    } else {
      admission = {
        state: 'withheld',
        reason: (lifecycle?.scoring_admission_withheld_reason ??
          SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES) as WithheldReason,
      };
    }
    if (contract.conversion_issues.length > 0 && admission.state === 'admitted') {
      admission = {
        state: 'withheld',
        reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
      };
    }

    const result = await publishQuestionGroup(tx, {
      group_id: rootId,
      contract,
      expectedCurrentRevision: expectedRevision,
      expectedAdmissionGeneration: expectedGeneration,
      availability:
        input.availability ??
        lifecycle?.availability ??
        (root.source === 'web_sourced' || root.source === 'quiz_gen'
          ? QUESTION_AVAILABILITY.GENERAL_POOL
          : QUESTION_AVAILABILITY.CONTAINER_ONLY),
      admission,
      suspension: input.suspension,
      verification: input.verification,
      claimPolicy: input.claimPolicy,
      readAssetBytes: input.readAssetBytes,
      actorRef: input.actorRef,
      now: input.now,
    });

    if (result.status === 'conflict') {
      // 锁后读取不应冲突；出现即外部越过 seam，回滚。
      throw new Error(
        `publishQuestionGroupFromRow: unexpected ${result.reason} conflict for group '${rootId}' (lifecycle written outside the seam?)`,
      );
    }
    return result;
  });
}

/**
 * Append a verify record without touching lifecycle dimensions; generation stays
 * current. The caller must already hold the lifecycle row lock.
 */
export async function appendAdmissionVerificationRecord(
  tx: Tx,
  input: {
    groupId: string;
    expectedRevisionId: string;
    expectedGeneration: number;
    verification: AdmissionVerificationWrite;
    now: Date;
  },
): Promise<void> {
  const [revision] = await tx
    .select({ integrity_digest: question_revision.integrity_digest })
    .from(question_revision)
    .where(eq(question_revision.revision_id, input.expectedRevisionId))
    .limit(1);
  if (!revision) {
    throw new Error(
      `appendAdmissionVerificationRecord: revision '${input.expectedRevisionId}' missing for group '${input.groupId}'`,
    );
  }
  await tx.insert(question_admission_verification).values({
    id: createId(),
    revision_id: input.expectedRevisionId,
    revision_digest: revision.integrity_digest,
    policy_id: input.verification.policy_id,
    generation: input.expectedGeneration,
    outcome: input.verification.outcome,
    evidence: input.verification.evidence ?? {},
    recorded_at: input.now,
  });
}

/** 发布事务内追加核验记录；generation 为写入后的 admission generation。 */
async function insertAdmissionVerification(
  tx: Tx,
  input: PublishQuestionGroupInput,
  revisionId: string,
  revisionDigest: string,
  generation: number,
): Promise<void> {
  const verification = input.verification;
  if (verification == null) return;
  await tx.insert(question_admission_verification).values({
    id: createId(),
    revision_id: revisionId,
    revision_digest: revisionDigest,
    policy_id: verification.policy_id,
    generation,
    outcome: verification.outcome,
    evidence: verification.evidence ?? {},
    recorded_at: input.now,
  });
}

export interface ArchiveGroupLifecycleResult {
  status: 'archived' | 'not_found';
}

/** withdrawn=true；claim 释放由 legacy hash 置 NULL 承担。 */
export async function archiveGroupLifecycle(
  tx: Tx,
  groupId: string,
  now: Date,
): Promise<ArchiveGroupLifecycleResult> {
  const updated = await tx
    .update(question_group_lifecycle)
    .set({ withdrawn: true, withdrawn_at: now, updated_at: now })
    .where(eq(question_group_lifecycle.group_id, groupId))
    .returning({ group_id: question_group_lifecycle.group_id });
  if (updated.length === 0) return { status: 'not_found' };
  return { status: 'archived' };
}

export interface RestoreGroupLifecycleResult {
  status: 'restored' | 'not_found' | 'claim_conflict';
  /** claim_conflict 时：占用同 content hash 的在库 question id。 */
  conflicting_question_id?: string;
}

/**
 * withdrawn=false + 原子重取 live claim；占用者存在即 claim_conflict。锁序
 * question 根 → lifecycle。verify 挂起不自动释放 claim。
 */
export async function restoreGroupLifecycle(
  tx: Tx,
  groupId: string,
  canonicalContentHash: string | null,
  now: Date,
): Promise<RestoreGroupLifecycleResult> {
  const [rootLock] = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, groupId))
    .for('update')
    .limit(1);
  if (!rootLock) return { status: 'not_found' };

  const [lifecycle] = await tx
    .select({ group_id: question_group_lifecycle.group_id })
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .for('update')
    .limit(1);
  if (!lifecycle) return { status: 'not_found' };

  if (canonicalContentHash != null) {
    // 先探测占用者：唯一索引冲突不会告诉你是谁。
    const [holder] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.canonical_content_hash, canonicalContentHash))
      .limit(1);
    if (holder && holder.id !== groupId) {
      return { status: 'claim_conflict', conflicting_question_id: holder.id };
    }
    const stamped = await tx
      .update(question)
      .set({ canonical_content_hash: canonicalContentHash, updated_at: now })
      .where(eq(question.id, groupId))
      .returning({ id: question.id });
    if (stamped.length === 0) return { status: 'not_found' };
  }

  await tx
    .update(question_group_lifecycle)
    .set({ withdrawn: false, withdrawn_at: null, updated_at: now })
    .where(eq(question_group_lifecycle.group_id, groupId));
  return { status: 'restored' };
}
