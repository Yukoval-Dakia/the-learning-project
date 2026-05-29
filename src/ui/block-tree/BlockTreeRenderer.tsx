import type { ReactNode } from 'react';

import type { EmbeddedCheckQuestion } from '@/ui/components/ArtifactSections';
import { EmbeddedCheckSection } from '@/ui/components/EmbeddedCheckSection';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Badge } from '@/ui/primitives/Badge';
import { AUTO_LINK_SYSTEM_LABEL, autoLinkChip } from './auto-link-chip';
import {
  ARTIFACT_REF_BLOCK_NODE,
  AUTO_LINKS_CONTAINER_NODE,
  type BlockTreeDoc,
  type BlockTreeMark,
  type BlockTreeNode,
  CALLOUT_BLOCK_NODE,
  CROSS_LINK_BLOCK_NODE,
  SEMANTIC_BLOCK_NODE,
  SEMANTIC_KIND_LABEL,
  SOURCE_TIER_LABEL,
  type SemanticBlockAttrs,
} from './types';

type CorrectionStatus =
  | { state: 'active'; correction_event_id: null; replacement_artifact_id: null }
  | { state: 'retracted'; correction_event_id: string; replacement_artifact_id: null }
  | { state: 'marked_wrong'; correction_event_id: string; replacement_artifact_id: null }
  | { state: 'superseded'; correction_event_id: string; replacement_artifact_id: string };

// YUK-95 P5 Lane-D — one system-maintained auto-link, as surfaced to the
// dismiss-button renderer (hub auto-zone only). `relation` is the chip's
// HubMeshRelation provenance; the dismiss POST sends both up.
export interface AutoLinkDismissTarget {
  artifact_id: string;
  relation: string | null;
}

interface BlockTreeRendererProps {
  bodyBlocks: BlockTreeDoc;
  subjectProfile: SlimSubjectProfile;
  embeddedQuestions?: EmbeddedCheckQuestion[];
  embeddedCheckStatus?: 'not_required' | 'pending' | 'ready' | 'failed';
  correctionBlocks?: Record<string, CorrectionStatus>;
  renderBlockActions?: (block: { id: string; status: CorrectionStatus }) => ReactNode;
  // YUK-95 P5 Lane-D — when provided, each system-maintained (`auto:true`)
  // crossLinkBlock in an AutoLinksContainer renders the returned node (the
  // hover dismiss × button). Omitted on read-only / non-hub surfaces.
  renderAutoLinkDismiss?: (target: AutoLinkDismissTarget) => ReactNode;
  // Client-side optimistic-hide set (artifact_ids the user just dismissed):
  // auto-links whose artifact_id is in this set are skipped before the next
  // server round-trip removes them.
  hiddenAutoLinkArtifactIds?: ReadonlySet<string>;
}

interface RenderCtx {
  renderAutoLinkDismiss?: (target: AutoLinkDismissTarget) => ReactNode;
  hiddenAutoLinkArtifactIds?: ReadonlySet<string>;
}

const ACTIVE_STATUS: CorrectionStatus = {
  state: 'active',
  correction_event_id: null,
  replacement_artifact_id: null,
};

function statusLabel(status: CorrectionStatus): string | null {
  if (status.state === 'active') return null;
  if (status.state === 'marked_wrong') return '已标错';
  if (status.state === 'retracted') return '已撤回';
  return '已替换';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function applyMarks(node: ReactNode, marks: BlockTreeMark[] | undefined): ReactNode {
  if (!marks || marks.length === 0) return node;
  return marks.reduce<ReactNode>((children, mark) => {
    if (mark.type === 'bold') return <strong>{children}</strong>;
    if (mark.type === 'italic') return <em>{children}</em>;
    if (mark.type === 'code') return <code>{children}</code>;
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '#';
      return <a href={href}>{children}</a>;
    }
    return children;
  }, node);
}

function renderInline(node: BlockTreeNode, key: string, ctx: RenderCtx): ReactNode {
  if (node.type === 'text') {
    return <span key={key}>{applyMarks(node.text ?? '', node.marks)}</span>;
  }
  return renderNode(node, key, ctx);
}

function renderChildren(node: BlockTreeNode, ctx: RenderCtx): ReactNode[] {
  return (node.content ?? []).map((child, idx) => renderInline(child, `${node.type}-${idx}`, ctx));
}

// YUK-95 P5 Lane-D — render one crossLinkBlock. `inAutoZone` is true when this
// link is a direct child of an AutoLinksContainer; only there do we surface the
// system marker + relation chip + dismiss button (manual cross_links elsewhere
// keep the plain card).
function renderCrossLink(
  node: BlockTreeNode,
  key: string,
  ctx: RenderCtx,
  inAutoZone: boolean,
): ReactNode {
  const attrs = asRecord(node.attrs);
  const chip = inAutoZone
    ? autoLinkChip(attrs)
    : { isAuto: false, relationLabel: null, relationToneClass: null };
  const artifactId = typeof attrs.artifact_id === 'string' ? attrs.artifact_id : null;
  const relation = typeof attrs.relation === 'string' ? attrs.relation : null;
  return (
    <div
      key={key}
      className={`block-tree-link-card${chip.isAuto ? ' block-tree-link-card--auto' : ''}`}
    >
      <div className="block-tree-link-card-head">
        <span>cross_link</span>
        {chip.isAuto ? (
          <span className="auto-link-system-tag">{AUTO_LINK_SYSTEM_LABEL}</span>
        ) : null}
        {chip.relationLabel ? (
          <span className={`auto-link-chip ${chip.relationToneClass ?? ''}`}>
            {chip.relationLabel}
          </span>
        ) : null}
        {chip.isAuto && artifactId && ctx.renderAutoLinkDismiss
          ? ctx.renderAutoLinkDismiss({ artifact_id: artifactId, relation })
          : null}
      </div>
      <strong>{String(attrs.title ?? attrs.artifact_id ?? 'Artifact')}</strong>
      {attrs.block_id ? <small>#{String(attrs.block_id)}</small> : null}
    </div>
  );
}

function renderNode(node: BlockTreeNode, key: string, ctx: RenderCtx): ReactNode {
  const attrs = asRecord(node.attrs);
  if (node.type === 'paragraph') return <p key={key}>{renderChildren(node, ctx)}</p>;
  if (node.type === 'heading') {
    const level = attrs.level === 2 || attrs.level === 3 || attrs.level === 4 ? attrs.level : 3;
    const HeadingTag = `h${level}` as 'h2' | 'h3' | 'h4';
    return <HeadingTag key={key}>{renderChildren(node, ctx)}</HeadingTag>;
  }
  if (node.type === 'bulletList') return <ul key={key}>{renderChildren(node, ctx)}</ul>;
  if (node.type === 'orderedList') return <ol key={key}>{renderChildren(node, ctx)}</ol>;
  if (node.type === 'listItem') return <li key={key}>{renderChildren(node, ctx)}</li>;
  if (node.type === 'hardBreak') return <br key={key} />;
  if (node.type === CROSS_LINK_BLOCK_NODE) {
    // A bare crossLinkBlock (not inside an AutoLinksContainer): manual link card.
    return renderCrossLink(node, key, ctx, false);
  }
  if (node.type === ARTIFACT_REF_BLOCK_NODE) {
    return (
      <div key={key} className="block-tree-link-card">
        <span>artifact_ref</span>
        <strong>{String(attrs.title ?? attrs.artifact_id ?? 'Artifact')}</strong>
      </div>
    );
  }
  if (node.type === CALLOUT_BLOCK_NODE) {
    return (
      <aside key={key} className="block-tree-callout">
        {attrs.title ? <strong>{String(attrs.title)}</strong> : null}
        {renderChildren(node, ctx)}
      </aside>
    );
  }
  if (node.type === AUTO_LINKS_CONTAINER_NODE) {
    // Auto-zone: each crossLinkBlock child renders with the system marker +
    // relation chip + dismiss button. Optimistically-hidden links are skipped.
    const children = (node.content ?? []).filter((child) => {
      if (child.type !== CROSS_LINK_BLOCK_NODE) return true;
      const childAttrs = asRecord(child.attrs);
      const id = typeof childAttrs.artifact_id === 'string' ? childAttrs.artifact_id : null;
      return !(id && ctx.hiddenAutoLinkArtifactIds?.has(id));
    });
    return (
      <aside key={key} className="block-tree-auto-links">
        <strong>{String(attrs.title ?? 'Related')}</strong>
        {children.map((child, idx) =>
          child.type === CROSS_LINK_BLOCK_NODE
            ? renderCrossLink(child, `auto-${idx}`, ctx, true)
            : renderInline(child, `auto-${idx}`, ctx),
        )}
      </aside>
    );
  }
  return (
    <div key={key} className="block-tree-unknown">
      {renderChildren(node, ctx)}
    </div>
  );
}

export function BlockTreeRenderer({
  bodyBlocks,
  subjectProfile,
  embeddedQuestions = [],
  embeddedCheckStatus = 'not_required',
  correctionBlocks = {},
  renderBlockActions,
  renderAutoLinkDismiss,
  hiddenAutoLinkArtifactIds,
}: BlockTreeRendererProps) {
  const subjectModel = resolveSubjectRenderModel(subjectProfile);
  const bodyProps = subjectContentProps(subjectModel, { className: 'artifact-section-body' });
  const notation = (subjectModel.renderConfig.notation ?? undefined) as
    | 'latex'
    | 'wenyan'
    | 'plaintext'
    | 'code'
    | undefined;
  const ctx: RenderCtx = { renderAutoLinkDismiss, hiddenAutoLinkArtifactIds };

  return (
    <div className="artifact-sections block-tree-renderer">
      {(bodyBlocks.content as BlockTreeNode[] | undefined)?.map((node, index) => {
        if (node.type !== SEMANTIC_BLOCK_NODE) {
          return renderNode(node, `node-${index}`, ctx);
        }
        const rawAttrs = asRecord(node.attrs);
        const attrs = rawAttrs as unknown as SemanticBlockAttrs;
        const id = typeof attrs.id === 'string' ? attrs.id : `block_${index}`;
        const kind = attrs.semantic_kind ?? 'definition';
        const sourceTier = attrs.source_tier ?? 'llm_only';
        const status = correctionBlocks[id] ?? ACTIVE_STATUS;
        const label = statusLabel(status);
        const sourceMarkdown =
          typeof rawAttrs.source_markdown === 'string' ? rawAttrs.source_markdown : null;
        const embeddedQuestionIds = attrs.embedded_check?.question_ids ?? [];
        const embeddedQuestionIdSet = new Set(embeddedQuestionIds);
        const blockQuestions = embeddedQuestions.filter((question) =>
          embeddedQuestionIdSet.has(question.id),
        );
        return (
          <section
            key={id}
            className="artifact-section block-tree-semantic-block"
            data-block-id={id}
          >
            <div className="artifact-section-head">
              <div className="artifact-section-labels">
                <strong>{SEMANTIC_KIND_LABEL[kind]}</strong>
                <span className="artifact-section-tier">{SOURCE_TIER_LABEL[sourceTier]}</span>
                {label ? (
                  <Badge tone={status.state === 'superseded' ? 'hard' : 'again'} dot dotStatic>
                    {label}
                  </Badge>
                ) : null}
              </div>
              {renderBlockActions ? (
                <div className="artifact-section-head-actions">
                  {renderBlockActions({ id, status })}
                </div>
              ) : null}
            </div>
            {sourceMarkdown !== null ? (
              <MathMarkdown {...bodyProps} notation={notation}>
                {sourceMarkdown}
              </MathMarkdown>
            ) : (
              <div {...bodyProps}>
                {(node.content ?? []).map((child, idx) => renderNode(child, `${id}-${idx}`, ctx))}
              </div>
            )}
            {kind === 'check' ? (
              <EmbeddedCheckSection
                status={embeddedCheckStatus}
                questions={blockQuestions}
                notation={notation}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
