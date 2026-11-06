// YUK-1877 — 判分侧照片证据转写：冻结输入增广层 + 执行器失败门。
//
// evaluateSubmissionCore 从 submission/member_inputs 联合出 per-unit 的
// entries 与 unitGroupEvidence —— 模型请求与引文已知集合
// （collectKnownEvidenceIds）同源于此。转写必须在 core 之前完成：本模块为
// 冻结的 SubmissionRecord 内存对象补出 UTF-8 明文附件（只增不改），transcript
// 附件随之进入模型请求与可引集合，明文走 text_evidence，引文校验
// （isOriginalEvidenceQuote 精确子串）自然成立。submission 行不可变，绝不回写；
// freezeEvaluationInput 的 digest 仍锚在原始成员行上（transcript 是派生产物，
// provenance 记进资产行）。
//
// 付费与持久化协议（本文件是唯一写入点 —— 危机分类恢复时在此集中加）：
//   - 产物 = `evidence_transcript` profile 的 source_asset（digest 寻址、
//     写一次、字节校验，persistImmutableAsset）。
//   - 终态收据 = event `evt_aets_<内容寻址>`，first-write-wins：同一图片
//     digest 全局只付一次转写费；重判/replay 读回收据即复用，零成本。
//   - 先写 asset（自管事务）再写 receipt（独立事务）：崩溃最多留孤儿对象，
//     下次按 byte-verified 复用；反向顺序会留指向缺失行的收据。
//   - 同一 digest 的并发首用经 session advisory lock 串行（跨付费调用，不持
//     tx）；锁外读收据、锁内复查再决定是否付费。
//   - infra 失败不写收据：下一轮真实调用重试，费用如实重复入账；illegible
//     是终态，写收据后该图片永远落 unreadable_evidence，不重付。
//   - 收据 caused_by 指向该次评估的 attempt 事件 —— 派生用途谓词经
//     attempt/session 继承 usage_policy / 危机标记；ingest_at 落写时即
//     置位，收据不进 memory outbox / Mem0。收据不携带转写文本。

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RunTaskResult } from '@/ai/task-result';
import { canonicalHash } from '@/core/migration/canonical';
import { stableStringify } from '@/core/migration/stable-stringify';
import type {
  EvidenceAttachmentT,
  ModelUnitExecutorPort,
  ModelUnitOutcomeT,
  PendingStateT,
  SubmissionRecordT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { event, source_asset } from '@/db/schema';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import { writeEvent } from '@/kernel/events';
import { parseTaskOutput } from '@/kernel/parse-task-output';
import {
  type AssessmentAssetLoader,
  withinAssessmentSignal,
} from '@/kernel/records/assessment-assets';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { persistImmutableAsset } from '@/kernel/records/asset-store';
import type { RunTaskCtx } from '@/server/ai/runner';
import { AssessmentEvidenceTranscriptionOutput } from '../tasks/evidence-transcription';
import { createAssessmentAssetLoader } from './assets';

export const EVIDENCE_TRANSCRIPTION_TASK_KIND = 'AssessmentEvidenceTranscriptionTask';
const RECEIPT_ACTION = 'experimental:assessment_evidence_transcription';
const LOCK_NAMESPACE = 'assessment_evidence_transcription';
// 收据锁定等待上限：竞态方正在付费转写，等它完成即零成本复用。
const LOCK_WAIT_MS = 120_000;

const ReceiptPayload = z.object({
  version: z.literal(1),
  status: z.enum(['transcribed', 'illegible']),
  image_asset_id: z.string().min(1),
  image_sha256: z.string().min(1),
  transcript_asset_id: z.string().optional(),
  transcript_sha256: z.string().optional(),
  detail: z.string().optional(),
});

export interface EvidenceTranscriptionDeps {
  db: Db;
  /** 读原图字节（默认 grading 资产 loader：source_asset 行 + R2 对象）。 */
  loadAsset?: AssessmentAssetLoader;
  /** 付费执行 seam（默认惰性 import runner；验收/测试注入）。 */
  runTask?: (
    kind: typeof EVIDENCE_TRANSCRIPTION_TASK_KIND,
    input: unknown,
    ctx: RunTaskCtx,
  ) => Promise<RunTaskResult>;
  /** 调用方墙钟：转写共享该单元判分的 provider-session 截止。 */
  deadlineAt?: number;
}

interface ImageEvidenceRef {
  evidence_id: string;
  asset_id: string;
  /** `sha256:<hex>` — EvidenceAttachment.asset.digest 的既有形态。 */
  digest: string;
  sha256: string;
  mime_type: string;
  uploaded_at: string;
}

type TranscriptResolution =
  | { ok: true; attachment: EvidenceAttachmentT; run_refs: string[]; cost_micros: number }
  | { ok: false; unreadable: boolean; detail: string; run_refs: string[]; cost_micros: number };

function isImageAttachment(attachment: EvidenceAttachmentT): boolean {
  return attachment.kind === 'image' && attachment.mime_type.startsWith('image/');
}

function sha256OfDigest(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice(7) : digest;
}

function receiptIdFor(image: ImageEvidenceRef): string {
  return `evt_aets_${canonicalHash({
    kind: 'evidence_transcription',
    image_asset_id: image.asset_id,
    image_sha256: image.sha256,
  })}`;
}

function transcriptAttachment(
  image: ImageEvidenceRef,
  row: { id: string; sha256: string; mime_type: string; byte_size: number },
): EvidenceAttachmentT {
  return {
    // 派生身份绑定原证据 id：同一次提交内引用关系自明，重判回放逐位一致。
    evidence_id: `transcript:${image.evidence_id}`,
    kind: 'plaintext',
    asset: { asset_id: row.id, digest: `sha256:${row.sha256}` },
    mime_type: row.mime_type,
    bytes: row.byte_size,
    uploaded_at: image.uploaded_at,
  };
}

/** submission 内全部 image 附件：group_evidence 与 open 槽位 evidence，按证据 id 去重。 */
function collectSubmissionImages(submissions: readonly SubmissionRecordT[]): ImageEvidenceRef[] {
  const attachments: EvidenceAttachmentT[] = submissions.flatMap((sub) => [
    ...sub.group_evidence.map((g) => g.evidence),
    ...sub.response_set.entries.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
  ]);
  const seen = new Set<string>();
  const out: ImageEvidenceRef[] = [];
  for (const attachment of attachments) {
    if (!isImageAttachment(attachment) || seen.has(attachment.evidence_id)) continue;
    seen.add(attachment.evidence_id);
    out.push({
      evidence_id: attachment.evidence_id,
      asset_id: attachment.asset.asset_id,
      digest: attachment.asset.digest,
      sha256: sha256OfDigest(attachment.asset.digest),
      mime_type: attachment.mime_type,
      uploaded_at: attachment.uploaded_at,
    });
  }
  return out;
}

async function resolveReceiptRow(
  db: Db,
  image: ImageEvidenceRef,
): Promise<TranscriptResolution | null> {
  const [saved] = await db
    .select()
    .from(event)
    .where(eq(event.id, receiptIdFor(image)))
    .limit(1);
  if (!saved) return null;
  const payload = ReceiptPayload.safeParse(saved.payload);
  if (!payload.success || payload.data.image_asset_id !== image.asset_id) {
    return {
      ok: false,
      unreadable: false,
      detail: `transcription receipt '${saved.id}' exists but does not match this image evidence`,
      run_refs: [],
      cost_micros: 0,
    };
  }
  if (payload.data.status === 'illegible') {
    return {
      ok: false,
      unreadable: true,
      detail: payload.data.detail ?? 'image evidence was recorded as illegible',
      run_refs: [],
      cost_micros: 0,
    };
  }
  const assetId = payload.data.transcript_asset_id;
  const assetSha = payload.data.transcript_sha256;
  if (assetId === undefined || assetSha === undefined) {
    return {
      ok: false,
      unreadable: false,
      detail: `transcription receipt '${saved.id}' lacks transcript asset identity`,
      run_refs: [],
      cost_micros: 0,
    };
  }
  const [row] = await db.select().from(source_asset).where(eq(source_asset.id, assetId)).limit(1);
  if (!row || row.sha256 !== assetSha || row.mime_type !== 'text/markdown') {
    return {
      ok: false,
      unreadable: false,
      detail: `transcription receipt '${saved.id}' points at a missing or divergent transcript asset`,
      run_refs: [],
      cost_micros: 0,
    };
  }
  return { ok: true, attachment: transcriptAttachment(image, row), run_refs: [], cost_micros: 0 };
}

async function writeReceipt(
  db: Db,
  image: ImageEvidenceRef,
  submissionId: string,
  payload: z.infer<typeof ReceiptPayload>,
  run: { task_run_id: string; cost_micros: number | null },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await writeEvent(tx, {
      id: receiptIdFor(image),
      actor_kind: 'system',
      actor_ref: 'assessment:evidence-transcription',
      action: RECEIPT_ACTION,
      subject_kind: 'source_asset',
      subject_id: image.asset_id,
      outcome: payload.status === 'transcribed' ? 'success' : 'failure',
      caused_by_event_id: assessmentAttemptEventId(submissionId),
      task_run_id: run.task_run_id,
      cost_micro_usd: run.cost_micros,
      payload,
      created_at: now,
      ingest_at: now,
    });
  });
}

async function transcribe(
  deps: EvidenceTranscriptionDeps,
  image: ImageEvidenceRef,
  submissionId: string,
  signal: AbortSignal,
): Promise<TranscriptResolution> {
  const loaded = await (deps.loadAsset ?? createAssessmentAssetLoader(deps.db))(
    { asset_id: image.asset_id, digest: image.digest },
    signal,
  );
  if (!loaded) {
    return {
      ok: false,
      unreadable: true,
      detail: `image asset '${image.asset_id}' bytes are unavailable; evidence cannot be judged`,
      run_refs: [],
      cost_micros: 0,
    };
  }
  const runTask = deps.runTask ?? (await import('@/server/ai/runner')).runTask;
  const result = await withinAssessmentSignal(
    () =>
      runTask(
        EVIDENCE_TRANSCRIPTION_TASK_KIND,
        {
          text: JSON.stringify({
            task: 'transcribe this learner answer image verbatim',
            image_asset_id: image.asset_id,
            evidence_id: image.evidence_id,
          }),
          images: [
            {
              data: Buffer.from(loaded.bytes).toString('base64'),
              mediaType: loaded.mime_type,
            },
          ],
        },
        {
          db: deps.db,
          signal,
          providerSessionDeadlineAt: deps.deadlineAt,
        },
      ),
    signal,
  );
  const costMicros =
    result.cost_usd !== undefined && Number.isFinite(result.cost_usd) && result.cost_usd >= 0
      ? Math.ceil(result.cost_usd * 1_000_000)
      : null;
  const output =
    result.structured_output === undefined
      ? parseTaskOutput(
          result.text,
          EVIDENCE_TRANSCRIPTION_TASK_KIND,
          AssessmentEvidenceTranscriptionOutput,
        )
      : AssessmentEvidenceTranscriptionOutput.parse(result.structured_output);
  const run = { task_run_id: result.task_run_id, cost_micros: costMicros };
  if (output.status === 'illegible') {
    const payload: z.infer<typeof ReceiptPayload> = {
      version: 1,
      status: 'illegible',
      image_asset_id: image.asset_id,
      image_sha256: image.sha256,
      ...(output.note ? { detail: output.note } : {}),
    };
    await writeReceipt(deps.db, image, submissionId, payload, run);
    return {
      ok: false,
      unreadable: true,
      detail: output.note ?? 'image evidence transcribed as illegible',
      run_refs: [result.task_run_id],
      cost_micros: costMicros ?? 0,
    };
  }
  const bytes = new TextEncoder().encode(output.transcript_md);
  const { getR2 } = await import('@/kernel/object-storage');
  const { row } = await persistImmutableAsset(deps.db, getR2(), {
    profile: 'evidence_transcript',
    bytes,
    provenance: {
      source_kind: 'evidence_transcription',
      transcribed_from: {
        asset_id: image.asset_id,
        sha256: image.sha256,
        evidence_id: image.evidence_id,
        mime_type: image.mime_type,
      },
      task_kind: EVIDENCE_TRANSCRIPTION_TASK_KIND,
      task_run_id: result.task_run_id,
    },
    // 没有 owner 行需要授权锁：身份即内容 digest，重复写入即复用。
    authorize: async () => {},
  });
  const payload: z.infer<typeof ReceiptPayload> = {
    version: 1,
    status: 'transcribed',
    image_asset_id: image.asset_id,
    image_sha256: image.sha256,
    transcript_asset_id: row.id,
    transcript_sha256: row.sha256,
  };
  await writeReceipt(deps.db, image, submissionId, payload, run);
  return {
    ok: true,
    attachment: transcriptAttachment(image, row),
    run_refs: [result.task_run_id],
    cost_micros: costMicros ?? 0,
  };
}

async function ensureTranscript(
  deps: EvidenceTranscriptionDeps,
  image: ImageEvidenceRef,
  submissionId: string,
  signal: AbortSignal,
): Promise<TranscriptResolution> {
  const resolved = await resolveReceiptRow(deps.db, image);
  if (resolved !== null) return resolved;
  // 收据缺失 ⇒ 可能付费。同一 digest 的并发首用串行化：锁内复查收据，
  // 后到者零成本复用前者刚写下的收据。
  const poolCapable = '$client' in deps.db && typeof deps.db.$client.reserve === 'function';
  if (!poolCapable) return transcribe(deps, image, submissionId, signal);
  return withinSessionAdvisoryLock(
    deps.db,
    {
      namespace: LOCK_NAMESPACE,
      key: image.sha256,
      busy: () => new Error(`evidence transcription lock busy for digest ${image.sha256}`),
    },
    new Date(Date.now() + LOCK_WAIT_MS),
    async (lockedDb) => {
      const recheck = await resolveReceiptRow(lockedDb, image);
      if (recheck !== null) return recheck;
      return transcribe({ ...deps, db: lockedDb }, image, submissionId, signal);
    },
  );
}

/**
 * 为冻结 submission 的内存副本补 transcript 附件（只增不改；digest 不变因为
 * freezeEvaluationInput 已在增广前锚定）。证据 id 冲突（提交自带
 * `transcript:` 前缀且字节不同）时不追加 —— 由分辨率记录失败，不制造
 * combineEvaluationMembers 的 ambiguous-evidence 抛错。
 */
function withTranscriptAttachments(
  sub: SubmissionRecordT,
  transcripts: Map<string, EvidenceAttachmentT>,
): SubmissionRecordT {
  const known = new Map<string, string>();
  for (const entry of sub.response_set.entries) {
    if (entry.kind === 'open')
      for (const evidence of entry.evidence)
        known.set(evidence.evidence_id, stableStringify(evidence));
  }
  for (const evidence of sub.group_evidence)
    known.set(evidence.evidence.evidence_id, stableStringify(evidence.evidence));
  // 提交自带同 id 证据且字节不同 ⇒ 冲突，拒绝追加（否则 combineEvaluationMembers
  // 会按 ambiguous evidence 抛错）；字节相同 = 同一附件，幂等允许重复追加。
  const attachable = (transcript: EvidenceAttachmentT) => {
    const previous = known.get(transcript.evidence_id);
    return previous === undefined || previous === stableStringify(transcript);
  };
  let changed = false;
  const entries = sub.response_set.entries.map((entry) => {
    if (entry.kind !== 'open') return entry;
    const derived = entry.evidence
      .map((e) => transcripts.get(e.evidence_id))
      .filter((t): t is EvidenceAttachmentT => t !== undefined && attachable(t));
    if (derived.length === 0) return entry;
    changed = true;
    return { ...entry, evidence: [...entry.evidence, ...derived] };
  });
  const group_evidence = sub.group_evidence.flatMap((g) => {
    const transcript = transcripts.get(g.evidence.evidence_id);
    if (transcript === undefined || !attachable(transcript)) return [g];
    changed = true;
    return [g, { evidence: transcript, target: g.target }];
  });
  if (!changed) return sub;
  return { ...sub, response_set: { entries }, group_evidence };
}

/** prepareEvidenceTranscriptions 的产物：增广后的 submission 视图 + 全量分辨率。 */
export interface PreparedEvidenceTranscriptions {
  /** image evidence_id → 转写结果（ok=附件；失败=显式状态）。 */
  readonly resolutions: ReadonlyMap<string, TranscriptResolution>;
  /** submission_id → 补了 transcript 附件的内存副本（无图时与原对象同引用）。 */
  submissionFor(id: string): SubmissionRecordT | undefined;
}

/**
 * core 之前的一次性转写准备：覆盖 anchor 与全部成员的 image 证据。
 * 付费判定走收据/advisory-lock 协议；本函数只按 evidence_id 去重 ——
 * 同一次评估内一张图至多一次付费决议（infra 失败也在内存去重，绝不按单元重付）。
 */
export async function prepareEvidenceTranscriptions(
  deps: EvidenceTranscriptionDeps,
  anchor: SubmissionRecordT,
  members: readonly { submission: SubmissionRecordT }[],
  signal?: AbortSignal,
): Promise<PreparedEvidenceTranscriptions> {
  const submissions = [anchor, ...members.map((member) => member.submission)];
  const images = collectSubmissionImages(submissions);
  const resolutions = new Map<string, TranscriptResolution>();
  const callerSignal = signal ?? new AbortController().signal;
  for (const image of images) {
    let resolution: TranscriptResolution;
    try {
      resolution = await ensureTranscript(deps, image, anchor.submission_id, callerSignal);
    } catch (error) {
      resolution = {
        ok: false,
        unreadable: false,
        detail: `transcription infrastructure failure: ${error instanceof Error ? error.message : String(error)}`,
        run_refs: [],
        cost_micros: 0,
      };
    }
    resolutions.set(image.evidence_id, resolution);
  }
  const transcripts = new Map<string, EvidenceAttachmentT>();
  for (const [evidenceId, resolution] of resolutions) {
    if (resolution.ok) transcripts.set(evidenceId, resolution.attachment);
  }
  const augmented = new Map<string, SubmissionRecordT>();
  for (const sub of submissions) {
    augmented.set(sub.submission_id, withTranscriptAttachments(sub, transcripts));
  }
  return {
    resolutions,
    submissionFor: (id) => augmented.get(id),
  };
}

/**
 * 判分执行器失败门：prepare 已完成增广，这里只把失败的图片证据按单元落成
 * 显式 pending（unreadable_evidence 终态 / infra_failure 可重试），并把成功
 * 转写的 run_refs/费用并入单元结果 —— 绝不让判分器对引不了的证据猜分。
 */
export function createEvidenceTranscriptionExecutor(
  inner: ModelUnitExecutorPort,
  prepared: PreparedEvidenceTranscriptions,
): ModelUnitExecutorPort {
  return async (request, signal) => {
    const failures: { unreadable: boolean; evidence_id: string; detail: string }[] = [];
    const runRefs: string[] = [];
    let costMicros = 0;
    const attachments: EvidenceAttachmentT[] = [
      ...request.group_evidence.map((g) => g.evidence),
      ...request.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
    ];
    const seen = new Set<string>();
    for (const attachment of attachments) {
      if (!isImageAttachment(attachment) || seen.has(attachment.evidence_id)) continue;
      seen.add(attachment.evidence_id);
      const resolution = prepared.resolutions.get(attachment.evidence_id);
      if (resolution === undefined) {
        failures.push({
          unreadable: false,
          evidence_id: attachment.evidence_id,
          detail: 'image evidence was never presented for transcription',
        });
        continue;
      }
      runRefs.push(...resolution.run_refs);
      costMicros += resolution.cost_micros;
      if (!resolution.ok) {
        failures.push({
          unreadable: resolution.unreadable,
          evidence_id: attachment.evidence_id,
          detail: resolution.detail,
        });
      }
    }
    if (failures.length > 0) {
      const anyInfra = failures.some((f) => !f.unreadable);
      const pending: PendingStateT = anyInfra
        ? {
            reason: 'infra_failure',
            retryable: true,
            detail: failures.map((f) => `${f.evidence_id}: ${f.detail}`).join('; '),
          }
        : {
            reason: 'unreadable_evidence',
            evidence_ids: failures.map((f) => f.evidence_id),
            detail: failures.map((f) => f.detail).join('; '),
          };
      return {
        kind: 'pending',
        pending,
        run_refs: runRefs,
        ...(costMicros > 0 ? { cost_usd_micros: costMicros } : {}),
      };
    }
    const outcome: ModelUnitOutcomeT = await inner(request, signal);
    if (runRefs.length === 0 && costMicros === 0) return outcome;
    return {
      ...outcome,
      run_refs: [...runRefs, ...outcome.run_refs],
      ...(costMicros > 0 ? { cost_usd_micros: costMicros + (outcome.cost_usd_micros ?? 0) } : {}),
    };
  };
}
