// M4-T6 (YUK-319/YUK-318)：提议卡（设计稿 screen-mistakes.jsx ProposalCard
// L60-124）。偏差（真 wire 适配，design pre-flight 预批）：
// ①SubjectTag 不渲——科目轴 M5 随 effective_domain 派生收编；
// ②「改关系」从即点即换改为 inline 展开 5 关系再选（真 decide 不可反复试）；
// ③evidence 渲多枚——真 evidence_refs 是数组，设计稿演示单枚。
// 裁决在卡内 async（busy per-card），错误经 onError 上抛页级 toast；
// resolved 留痕 map 由 InboxPage 持有（设计稿同构）。
// M3E 呈现（YUK-1473）：ui-next Card / Button / ChipButton + lucide，样式在 inbox-m3e.css；
// 设计记录 docs/design/2026-11-03-inbox-agent-notes-events-m3e.md。裁决逻辑未动。

import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  FileQuestion,
  FileText,
  Image,
  Link2,
  type LucideIcon,
  Network,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useState } from 'react';
// Type-only (erased at compile time — does NOT pull react-markdown into the main bundle,
// the deferred loader still owns the runtime import).
import type { Components } from 'react-markdown';
import { isPublicHttpUrl } from '@/core/net/private-host';
import { ApiError } from '@/ui/lib/api';
import { DeferredMarkdownRenderer } from '@/ui/lib/deferred-markdown-renderer';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { invalidateAfterProposalDecision } from '@/ui/lib/write-invalidation';
import { Card } from '@/ui-next/primitives/Card';
import { ChipButton } from '@/ui-next/primitives/Chip';
import { Button } from '@/ui-next/public';
import {
  type ProposalDecision,
  type ProposalEvidenceRefWire,
  type ProposalInboxRow,
  REL_LABEL,
  dedupeEvidence,
  evidenceReadable,
  isAcceptSupported,
  isBlockMergeStale,
  kindMeta,
  reasonWithoutIds,
  splitReasonIds,
} from './inbox-api';
import { inboxTone, kindIcon } from './inbox-look';
import { MutationPreview, mutationBlockedWords, mutationFullyNamed } from './mutation-preview';
import { useWorkbenchClient } from './workbench-client';

/** Same cap as a new proposal's one sentence. */
const LEGACY_BODY_MAX = 80;
// There is nothing to decide from without the reason: these cards do not say what they act on, and
// a conjecture's reason is the very claim being decided.
const REASON_STAYS_IN_VIEW: ReadonlySet<string> = new Set([
  'knowledge_mutation',
  'record_links',
  'record_promotion',
  'completion',
  'relearn',
  'note_update',
  'conjecture',
]);

const EV_ICON: Record<string, LucideIcon> = {
  event: Sparkles,
  question: FileQuestion,
  knowledge: Network,
  artifact: FileText,
  record: FileText,
};

interface LearningItemPlanPreview {
  hubTitle: string;
  summary: string | null;
  steps: Array<{ title: string; intent: string | null; kind: 'atomic' | 'long' }>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function learningItemStepOf(
  value: unknown,
  kind: 'atomic' | 'long',
): LearningItemPlanPreview['steps'][number] | null {
  const row = recordOf(value);
  if (!row || typeof row.title !== 'string' || row.title.length === 0) return null;
  return {
    title: row.title,
    intent: typeof row.one_line_intent === 'string' ? row.one_line_intent : null,
    kind,
  };
}

/** Display-only, defensive projection of the free-form learning_item proposed_change. */
export function learningItemPlanPreviewOf(change: unknown): LearningItemPlanPreview | null {
  const plan = recordOf(change);
  const hub = recordOf(plan?.hub);
  if (!hub || typeof hub.title !== 'string' || hub.title.length === 0) return null;
  const atomics = Array.isArray(plan?.atomics) ? plan.atomics : [];
  const longs = Array.isArray(plan?.longs) ? plan.longs : [];
  const steps = [
    ...atomics.map((row) => learningItemStepOf(row, 'atomic')),
    ...longs.map((row) => learningItemStepOf(row, 'long')),
  ].filter((row): row is LearningItemPlanPreview['steps'][number] => row !== null);
  return {
    hubTitle: hub.title,
    summary: typeof hub.summary_md === 'string' ? hub.summary_md : null,
    steps,
  };
}

// YUK-229 — image_candidate 专属卡的显示投影。source_url 是候选来源页/图片直链，
// source_title 是来源标题，summary_md 是 AI 对该图题的摘要（题文预览）。图字节永不
//在 payload；该 kind 已退役，此投影只为遗留 pending 行提供正常展示。
export interface ImageCandidateView {
  sourceUrl: string;
  sourceTitle: string;
  summaryMd: string;
  /**
   * 通过共享 SSRF 字面量守卫（@/core/net/private-host.isPublicHttpUrl）的安全 http(s) src，
   * 或 null。null = 非 http(s) / 含凭据 / 字面私网·本机·链路本地 host——一律走纯文本降级，
   * 绝不把浏览器 <img> 指向它。
   */
  imgSrc: string | null;
}

/** Display-only, defensive projection of the free-form image_candidate proposed_change. */
export function imageCandidateViewOf(change: unknown): ImageCandidateView | null {
  const row = recordOf(change);
  if (!row) return null;
  const sourceUrl = typeof row.source_url === 'string' ? row.source_url : '';
  const sourceTitle = typeof row.source_title === 'string' ? row.source_title : '';
  const summaryMd = typeof row.summary_md === 'string' ? row.summary_md : '';
  if (sourceUrl === '' && sourceTitle === '' && summaryMd === '') return null;
  return {
    sourceUrl,
    sourceTitle,
    summaryMd,
    imgSrc: sourceUrl !== '' && isPublicHttpUrl(sourceUrl) ? sourceUrl : null,
  };
}

// 安全（YUK-229 review codex #2）：summary_md 里的 Markdown 图片语法 ![](url) 默认会被
// react-markdown 渲成真实 <img> → 又一条被动内网探测后门（同 source_url 直渲问题）。覆写
// img 组件为不加载的占位文本（绝不产出任何 src / 发 GET），把被动探测从 markdown 后门也堵死。
// 其余 markdown（含链接 <a>，不自动取回）沿用默认渲染。
const IC_MARKDOWN_COMPONENTS: Components = {
  img: ({ alt, src }) => (
    <span className="ib-ic-md-img" data-testid="ic-md-img-block">
      [图片：{alt || (typeof src === 'string' ? src : '') || '未命名'}]
    </span>
  ),
};

// 原图对照列。三态经早返回分派（仓库规约禁嵌套三元）：已揭示→图；可加载未揭示→点击
// 揭示 affordance；不可加载→来源纯文本降级卡。onError 翻 imgFailed → 回落。
function ImageFigureColumn({ view }: { view: ImageCandidateView }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const loadable = view.imgSrc !== null && !imgFailed;

  if (loadable && revealed) {
    return (
      <figure className="ib-ic-figure">
        <img
          className="ib-ic-img"
          src={view.imgSrc ?? undefined}
          alt={view.sourceTitle || '候选来源原图'}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
        {view.sourceTitle && <figcaption className="ib-ic-caption">{view.sourceTitle}</figcaption>}
      </figure>
    );
  }

  if (loadable) {
    return (
      <div className="ib-ic-reveal">
        {view.sourceTitle && <b className="ib-ic-source-title">{view.sourceTitle}</b>}
        <Button size="sm" variant="ghost" onClick={() => setRevealed(true)}>
          <Image size={14} aria-hidden="true" />
          显示原图预览
        </Button>
        <span className="ib-ic-note">原图由外部来源提供，点击后才从来源加载</span>
      </div>
    );
  }

  return (
    <div className="ib-ic-reveal">
      <span className="ib-ic-note">
        {view.imgSrc === null && view.sourceUrl
          ? '来源地址非公开图片直链，不内联加载，仅显示来源信息：'
          : '无法内联加载原图，仅显示来源信息：'}
      </span>
      {view.sourceTitle && <b className="ib-ic-source-title">{view.sourceTitle}</b>}
      {view.sourceUrl && <span className="ib-ic-source-url">{view.sourceUrl}</span>}
    </div>
  );
}

// 专属卡：题文（summary_md 预览）与原图并排对照。
// 安全（YUK-229 review）：外部 source_url 是 AI/外部来源写的，直渲 <img> 会在用户打开
// inbox 时就发起被动 GET，可被用来从用户浏览器探测内网（DNS rebinding 浏览器端防不了）。
// 双层防护：① imgSrc 已过共享字面量守卫（isPublicHttpUrl 拒私网/本机 host）；② 默认不
// 自动加载——用户显式点「显示原图预览」才设 src，把被动探测降为主动行为。onError 仍降级。
function ImageCandidateCard({ view }: { view: ImageCandidateView }) {
  return (
    <div className="ib-ic">
      <div className="ib-ic-col">
        <span className="ib-kicker">题文摘要</span>
        {view.summaryMd ? (
          <DeferredMarkdownRenderer className="ib-md" components={IC_MARKDOWN_COMPONENTS}>
            {view.summaryMd}
          </DeferredMarkdownRenderer>
        ) : (
          <span className="ib-ic-note">（无题文摘要）</span>
        )}
      </div>
      <div className="ib-ic-col">
        <span className="ib-kicker">原图对照</span>
        <ImageFigureColumn view={view} />
      </div>
    </div>
  );
}

function EvidenceChip({
  er,
  count,
  label: curatedLabel,
  navigate,
}: {
  er: ProposalEvidenceRefWire;
  count: number;
  label?: string;
  navigate: (to: string) => void;
}) {
  const { text, route } = evidenceReadable(er);
  // S7 (YUK-335)：去重后 count>1 时把数量并进文案（「源自 N 次 AI 判定事件」式），
  // 单枚保持原句不动。
  const label = curatedLabel ?? (count > 1 ? text.replace('一', String(count)) : text);
  const EvIcon = EV_ICON[er.kind] ?? FileText;
  const content = (
    <>
      <EvIcon size={13} aria-hidden="true" className="ib-ev-ic" />
      <span className="ib-ev-text">{label}</span>
    </>
  );

  // A missing detail route is display-only evidence, not a disabled action.
  if (!route) return <span className="ib-ev">{content}</span>;

  return (
    <button type="button" className="ib-ev ib-ev-link un-hit" onClick={() => navigate(route)}>
      {content}
      <span className="ib-ev-go">查看 →</span>
    </button>
  );
}

type MergeBlockPreview = NonNullable<
  NonNullable<NonNullable<ProposalInboxRow['presentation']>['block_merge']>['primary']
>;

// Sub-questions and options of a merge block (YUK-1404 preview contract). Counts are the full
// totals; the lists are capped, so the remainder is stated. null means the structure is unknown.
// Question text in a merge card. With the upload's subject notation (YUK-1404) it goes through the
// shared math renderer; without it the text stays plain, since markdown could misread `*` or `_`.
function MergeText({ text, notation }: { text: string; notation: string | null }) {
  if (!notation) return <>{text}</>;
  return (
    <MathMarkdown notation={notation} className="ib-merge-math">
      {text}
    </MathMarkdown>
  );
}

function BlockStructure({
  block,
  notation,
}: {
  block: MergeBlockPreview;
  notation: string | null;
}) {
  const subMore = (block.sub_question_count ?? 0) - block.sub_questions.length;
  const optMore = (block.option_count ?? 0) - block.options.length;
  if (block.sub_question_count === null && block.option_count === null) {
    return <div className="ib-merge-note">这道题的小问和选项还没整理出来</div>;
  }
  return (
    <>
      {block.sub_questions.length > 0 && (
        <ul className="ib-merge-structure">
          {block.sub_questions.map((sub) => (
            <li key={`${sub.label}\u0000${sub.excerpt}`}>
              <b>{sub.label}</b> <MergeText text={sub.excerpt} notation={notation} />
            </li>
          ))}
        </ul>
      )}
      {subMore > 0 && <div className="ib-merge-note">还有 {subMore} 个小问</div>}
      {block.options.length > 0 && (
        <ul className="ib-merge-structure">
          {block.options.map((option) => (
            <li key={`${option.label}\u0000${option.text}`}>
              <b>{option.label}</b> <MergeText text={option.text} notation={notation} />
            </li>
          ))}
        </ul>
      )}
      {optMore > 0 && <div className="ib-merge-note">还有 {optMore} 个选项</div>}
    </>
  );
}

// The CTA that had focus is hidden while confirming; hand focus to 「确认合并」 when that button
// appears. A module-level callback keeps one identity, so React calls it only when the node is
// attached, never on later re-renders: background updates cannot pull focus back.
function focusWhenShown(node: HTMLButtonElement | null) {
  node?.focus();
}

// Confidence shown on the card: none for conjectures; else the payload's, else a block merge's
// proposed_change confidence (early returns instead of a chained ternary).
function confidenceOf(
  p: ProposalInboxRow,
  change: ProposalInboxRow['payload']['proposed_change'],
): number | null {
  if (p.kind === 'conjecture') return null;
  if (typeof p.payload.confidence === 'number') return p.payload.confidence;
  if (p.kind === 'block_merge' && typeof change?.confidence === 'number') return change.confidence;
  return null;
}

export interface ProposalCardProps {
  p: ProposalInboxRow;
  index: number;
  /** 裁决留痕文案（如「已接受」）；null = 未裁决。 */
  resolved: string | null;
  navigate: (to: string) => void;
  onResolve: (id: string, label: string) => void;
  onError: (msg: string) => void;
}

const MERGE_BLOCKED_WORDS: Readonly<Record<string, string>> = {
  blocks_missing: '找不到可以合并的题块。',
  session_mismatch: '这些题块和这条提议说的不是同一次录入。',
  unknown_source: '这些题块不是来自同一份资料，或者找不到原资料。',
  ambiguous_page_index: '读不出这些题块在第几页，没法确认它们前后相连。',
  pages_not_adjacent: '这些题块的页码不是按顺序紧挨着的。',
  conflicting_question_number: '后面的题块有自己的题号，看起来是另一道题。',
  missing_continuity: '读不出这些题块是不是连在一起的。',
};

export function ProposalCard({ p, resolved, navigate, onResolve, onError }: ProposalCardProps) {
  const meta = kindMeta(p.kind);
  const client = useWorkbenchClient();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pickingRel, setPickingRel] = useState(false);
  // Block merges are irreversible: accept first asks for an explicit confirmation.
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  // codex 验证轮 P3：裁决留痕后按钮组整体锁定——卡片留在列表里，再点会
  // 重复请求 / 反向操作直接 409。
  const locked = busy || resolved !== null;

  const decide = async (
    decision: ProposalDecision,
    label: string,
    opts: { newRelationType?: string; confirmLossy?: true } = {},
  ) => {
    setBusy(true);
    try {
      const result = await client.decideProposal(p.id, decision, opts);
      // YUK-271（codex 验证轮 P2）：stale 的 block_merge accept 没写 rate
      // event，提议仍 pending——不标已裁决，经页级 toast 说明后保持可操作。
      if (isBlockMergeStale(result)) {
        setConfirmingMerge(false);
        onError('这条合并建议已失效：相关的题已经变了，已跳过。');
        return;
      }
      setConfirmingMerge(false);
      onResolve(p.id, label);
      // The decided card stays put; refresh what the decision changed elsewhere (sidebar count,
      // 待你试做, digest, and the proposal kind's own reads) without waiting on it here.
      void invalidateAfterProposalDecision(qc, { kind: p.kind });
    } catch (err) {
      // The server refuses an unconfirmed merge; show the confirmation instead of an error.
      if (err instanceof ApiError && err.status === 409 && err.code === 'confirm_required') {
        setConfirmingMerge(true);
        return;
      }
      setConfirmingMerge(false);
      onError(err instanceof Error ? err.message : '裁决失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const isEdge = p.kind === 'knowledge_edge';
  const change = p.payload.proposed_change;
  // YUK-1781 — the server's own reason this merge can't be accepted. Accepting would only get a 409,
  // so the card says why and offers dismiss alone.
  const mergeBlockedWords = p.not_acceptable_reason
    ? (MERGE_BLOCKED_WORDS[p.not_acceptable_reason] ?? '存下来的信息证明不了这是同一道题。')
    : null;
  const knowledgeChange = p.presentation?.knowledge_mutation;
  const changeBlockedWords = knowledgeChange ? mutationBlockedWords(knowledgeChange) : null;
  const blockedWords = mergeBlockedWords ?? changeBlockedWords;
  // Merging knowledge cannot be undone either, so it asks first, like merging question blocks.
  const mergesKnowledge = knowledgeChange?.mutation === 'merge';
  // ADR-0032 D4-E1 / YUK-332 — legacy proposals have no discriminator and are creates.
  // Archive proposals are destructive and only support accept/dismiss server-side, so their
  // operation, CTA copy, and available controls must not masquerade as create semantics.
  const isArchiveEdge = isEdge && change?.edge_op === 'archive';
  const archiveTargetMissing = isArchiveEdge && !change?.archive_edge_id;
  let cardLabel = meta.label;
  let cardIcon = meta.icon;
  let cardTone = meta.tone;
  let acceptButtonLabel = '接受';
  let acceptedLabel = '已接受';
  let edgeOperationLabel = '将新增';
  if (p.kind === 'block_merge' || mergesKnowledge) {
    acceptButtonLabel = '接受合并';
  } else if (isArchiveEdge) {
    cardLabel = '归档知识关系';
    cardIcon = 'archive';
    cardTone = 'hard';
    acceptButtonLabel = '确认归档';
    acceptedLabel = '已归档';
    edgeOperationLabel = archiveTargetMissing ? '归档目标缺失' : '将归档';
  } else if (isEdge) {
    cardLabel = '新增知识关系';
    acceptButtonLabel = '建立关系';
    acceptedLabel = '已建立';
  }
  const edgeFrom = isEdge ? change?.from_knowledge_id : undefined;
  const edgeTo = isEdge ? change?.to_knowledge_id : undefined;
  const rel = change?.relation_type;
  const confidence = confidenceOf(p, change);
  const learningPlan =
    p.kind === 'learning_item' ? learningItemPlanPreviewOf(p.payload.proposed_change) : null;
  const imageCandidate =
    p.kind === 'image_candidate' ? imageCandidateViewOf(p.payload.proposed_change) : null;
  const mergePreview = p.kind === 'block_merge' ? p.presentation?.block_merge : null;
  const mergeBlockLabelById = new Map(
    mergePreview
      ? [mergePreview.primary, ...mergePreview.merged]
          .filter((block) => block !== null)
          .map((block) => [block.id, block.label] as const)
      : [],
  );
  const CardIcon = kindIcon(cardIcon);
  // Without a sentence of its own, a card leaves its reason, which is internal text, under the fold
  // and is read from its title and change details. A card those cannot decide keeps the reason in
  // view, cut to two lines when long. So does a relation whose end has no name: the server then
  // sends the start of the id as its label.
  const ownSummary = p.payload.learner_summary ? p.presentation?.learner_summary : undefined;
  const edgeLabels = p.presentation?.knowledge_edge;
  const edgeUnnamed =
    isEdge &&
    (edgeLabels?.from_label === undefined ||
      edgeLabels.to_label === undefined ||
      edgeLabels.from_label === edgeFrom?.slice(0, 8) ||
      edgeLabels.to_label === edgeTo?.slice(0, 8));
  const reasonInView =
    !ownSummary &&
    (edgeUnnamed ||
      (REASON_STAYS_IN_VIEW.has(p.kind) &&
        !(knowledgeChange && mutationFullyNamed(knowledgeChange))));
  const legacySegments = splitReasonIds(p.presentation?.learner_summary ?? p.payload.reason_md);
  // The first thing read holds no ids: a known block keeps its name, anything else waits in the fold.
  const legacyBody = reasonWithoutIds(
    p.presentation?.learner_summary ?? p.payload.reason_md,
    (id) => mergeBlockLabelById.get(id),
  );
  const reasonFolded =
    !reasonInView || legacyBody.length > LEGACY_BODY_MAX || legacySegments.some((seg) => seg.raw);
  // YUK-264：不透明 ID 不露出来；已加载的题块显示位置身份，其他引用折叠为通用标签，原 ID 只保留在 hover title 供追溯。
  const reasonText = (text: string, learnerSentence = false) =>
    splitReasonIds(text, learnerSentence).map((seg) =>
      seg.raw ? (
        <button
          type="button"
          key={seg.start}
          className="ib-rawid"
          title={`复制引用 ${seg.text}`}
          onClick={() => {
            // navigator.clipboard is missing over the plain-HTTP LAN address.
            if (!navigator.clipboard) {
              onError('这个地址下不能复制，可以手动选中文字复制。');
              return;
            }
            void navigator.clipboard.writeText(seg.text).catch(() => onError('复制技术引用失败。'));
          }}
        >
          {mergeBlockLabelById.get(seg.text) ?? '技术引用'}
        </button>
      ) : (
        <span key={seg.start}>{seg.text}</span>
      ),
    );

  return (
    <Card as="article" className="ib-prop" data-resolved={resolved ? '' : undefined}>
      <div className="ib-prop-head">
        <span className="ib-tag" data-tone={inboxTone(cardTone)}>
          <CardIcon size={13} aria-hidden="true" />
          {cardLabel}
        </span>
        <span className="ib-tag ib-tag-ai">
          <Sparkles size={12} aria-hidden="true" />
          AI 建议
        </span>
        {/* YUK-617 mode-1 — 修正类建议标签（suggestion_kind=corrective 不计接受率）；
            proactive / 缺失不渲染。字段已在 wire（BaseProposal 顶层）。 */}
        {p.payload.suggestion_kind === 'corrective' && (
          <span className="ib-tag ib-tag-dashed" title="修正类建议不计入接受率">
            修正
          </span>
        )}
        {p.presentation?.title && <span className="ib-prop-title">{p.presentation.title}</span>}
        {resolved && (
          <span className="ib-tag ib-stamp" data-tone="positive">
            <Check size={13} aria-hidden="true" />
            {resolved}
          </span>
        )}
      </div>

      {ownSummary ? <p className="ib-prop-reason">{reasonText(ownSummary, true)}</p> : null}
      {reasonInView ? (
        <div
          className="ib-prop-reason"
          data-clamp={legacyBody.length > LEGACY_BODY_MAX ? '' : undefined}
        >
          {legacyBody || '理由都是技术引用，在下面的依据里。'}
        </div>
      ) : null}

      {knowledgeChange ? <MutationPreview mutation={knowledgeChange} /> : null}

      {!knowledgeChange && p.presentation && p.presentation.change_summary.length > 0 && (
        <dl className="ib-prop-summary">
          {p.presentation.change_summary.map((item) => (
            <div key={`${item.label}:${item.value}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {learningPlan && (
        <div className="ib-plan">
          <div className="ib-plan-hub">
            <span className="ib-kicker">学习主线</span>
            <b className="ib-plan-title">{learningPlan.hubTitle}</b>
            {learningPlan.summary && <span className="ib-plan-sum">{learningPlan.summary}</span>}
          </div>
          {learningPlan.steps.length > 0 && (
            <ol className="ib-plan-steps">
              {learningPlan.steps.map((step) => (
                <li key={`${step.kind}:${step.title}:${step.intent ?? ''}`}>
                  <span className="ib-plan-dot" data-kind={step.kind} aria-hidden="true" />
                  <span>
                    <b>{step.title}</b>
                    {step.intent && <small>{step.intent}</small>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {imageCandidate && <ImageCandidateCard view={imageCandidate} />}

      {mergePreview?.primary && mergePreview.merged.length > 0 && (
        <div className="ib-merge">
          <div className="ib-merge-block">
            <p className="ib-kicker">保留这道 · {mergePreview.primary.label}</p>
            <div className="ib-merge-text">
              <MergeText text={mergePreview.primary.excerpt} notation={mergePreview.notation} />
            </div>
            <BlockStructure block={mergePreview.primary} notation={mergePreview.notation} />
          </div>
          <div className="ib-merge-join" aria-hidden="true">
            <ArrowRight size={16} />
          </div>
          <div className="ib-merge-block ib-merge-into">
            <p className="ib-kicker">并进来的 {mergePreview.merged.length} 道</p>
            {mergePreview.merged.map((block) => (
              <div className="ib-merge-text ib-merge-part" key={block.id}>
                <b>{block.label}</b>
                <div>
                  <MergeText text={block.excerpt} notation={mergePreview.notation} />
                </div>
                <BlockStructure block={block} notation={mergePreview.notation} />
              </div>
            ))}
          </div>
          {mergePreview.continuity_label && (
            <div className="ib-merge-reason">
              <Sparkles size={12} aria-hidden="true" />
              连续依据：{mergePreview.continuity_label}
            </div>
          )}
        </div>
      )}

      {isEdge && edgeFrom && edgeTo && (
        <div className="ib-edge">
          <span className="ib-tag" data-tone={isArchiveEdge ? 'critical' : 'accent'}>
            {isArchiveEdge ? (
              <Archive size={12} aria-hidden="true" />
            ) : (
              <Link2 size={12} aria-hidden="true" />
            )}
            {edgeOperationLabel}
          </span>
          <span className="ib-tag ib-tag-outline">{(rel && REL_LABEL[rel]) || rel || '关系'}</span>
          <span className="ib-edge-node">
            {p.presentation?.knowledge_edge?.from_label ?? edgeFrom.slice(0, 8)}
          </span>
          <ArrowRight size={14} aria-hidden="true" className="ib-edge-arrow" />
          <span className="ib-edge-node">
            {p.presentation?.knowledge_edge?.to_label ?? edgeTo.slice(0, 8)}
          </span>
        </div>
      )}

      {confirmingMerge && !resolved && !blockedWords && (
        <div className="ib-confirm" role="alert">
          <b>合并后无法撤销</b>
          <span>
            {knowledgeChange?.mutation === 'merge'
              ? `被并走的知识点不再单独存在，只保留「${knowledgeChange.into.label}」。`
              : '并进来的题会成为保留那道题的一部分，之后不能再拆开。'}
          </span>
          <div className="ib-acts">
            <Button
              ref={focusWhenShown}
              size="sm"
              className="ib-btn-critical"
              disabled={locked}
              onClick={() =>
                void decide('accept', acceptedLabel, mergesKnowledge ? {} : { confirmLossy: true })
              }
            >
              <Check size={14} aria-hidden="true" />
              确认合并
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => setConfirmingMerge(false)}
            >
              先不合并
            </Button>
          </div>
        </div>
      )}

      {blockedWords && !resolved && (
        <div className="ib-prop-blocked">
          <b>
            <TriangleAlert size={14} aria-hidden="true" />
            {mergeBlockedWords ? '不能合并' : '现在接受不了'}
          </b>
          <span>{blockedWords}</span>
        </div>
      )}

      {reasonFolded || p.payload.evidence_refs.length > 0 ? (
        <details className="ib-why">
          <summary className="ib-why-toggle un-hit">
            查看依据
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="ib-why-body">
            {reasonFolded ? (
              <div className="ib-prop-reason ib-why-reason">{reasonText(p.payload.reason_md)}</div>
            ) : null}
            {p.payload.evidence_refs.length > 0 ? (
              <div className="ib-evidence">
                {/* S7 (YUK-335)：同 readable 文案去重 + 计数，避免 N 枚一模一样的灰 chip。 */}
                {dedupeEvidence(p.payload.evidence_refs, p.presentation?.evidence_labels).map(
                  ({ ref, count }) => (
                    <EvidenceChip
                      key={`${ref.kind}:${ref.id}`}
                      er={ref}
                      count={count}
                      label={p.presentation?.evidence_labels[`${ref.kind}:${ref.id}`]}
                      navigate={navigate}
                    />
                  ),
                )}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <div className="ib-prop-foot">
        <div className="ib-acts ib-prop-acts">
          {/* M4 review fix (codex P2)：defer/archive/judge_retraction 的 accept
              在 dispatchAccept 是 400（unsupported_proposal_kind），不渲 CTA。 */}
          {isAcceptSupported(p.kind) && !confirmingMerge && !blockedWords && (
            <Button
              size="sm"
              className={isArchiveEdge ? 'ib-btn-critical' : undefined}
              disabled={locked || archiveTargetMissing}
              onClick={() =>
                p.kind === 'block_merge' || mergesKnowledge
                  ? setConfirmingMerge(true)
                  : void decide('accept', acceptedLabel)
              }
            >
              {isArchiveEdge ? (
                <Archive size={14} aria-hidden="true" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}
              {acceptButtonLabel}
            </Button>
          )}
          {isEdge && !isArchiveEdge && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => void decide('reverse', '已改方向')}
              >
                <ArrowLeftRight size={14} aria-hidden="true" />
                改方向
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                aria-expanded={pickingRel}
                onClick={() => setPickingRel((v) => !v)}
              >
                <RefreshCw size={14} aria-hidden="true" />
                改关系
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => void decide('dismiss', isArchiveEdge ? '已保留' : '已忽略')}
          >
            <X size={14} aria-hidden="true" />
            {isArchiveEdge ? '保留关系' : '忽略'}
          </Button>
        </div>
        <div className="ib-prop-meta">
          {confidence !== null && (
            <span className="ib-conf">
              <span>置信</span>
              <span className="ib-conf-track" aria-hidden="true">
                <span style={{ width: `${Math.round(confidence * 100)}%` }} />
              </span>
              <span className="un-num">{Math.round(confidence * 100)}%</span>
            </span>
          )}
          {p.cost_micro_usd != null && (
            <span className="un-num">${(p.cost_micro_usd / 1e6).toFixed(4)}</span>
          )}
        </div>
      </div>

      {pickingRel && !resolved && !isArchiveEdge && (
        <fieldset className="ib-rel-pick">
          <legend className="ib-rel-legend">改为关系类型</legend>
          {Object.entries(REL_LABEL).map(([k, label]) => (
            <ChipButton
              key={k}
              tone={rel === k ? 'accent' : 'neutral'}
              aria-current={rel === k ? 'true' : undefined}
              disabled={locked}
              onClick={() => void decide('change_type', '已改关系', { newRelationType: k })}
            >
              {label.split(' ')[0]}
            </ChipButton>
          ))}
        </fieldset>
      )}
    </Card>
  );
}
