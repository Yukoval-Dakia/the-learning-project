import type { ReactNode } from 'react';

import type { EmbeddedCheckQuestion } from '@/ui/components/ArtifactSections';
import { EmbeddedCheckSection } from '@/ui/components/EmbeddedCheckSection';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Badge } from '@/ui/primitives/Badge';
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

interface BlockTreeRendererProps {
  bodyBlocks: BlockTreeDoc;
  subjectProfile: SlimSubjectProfile;
  embeddedQuestions?: EmbeddedCheckQuestion[];
  embeddedCheckStatus?: 'not_required' | 'pending' | 'ready' | 'failed';
  correctionBlocks?: Record<string, CorrectionStatus>;
  renderBlockActions?: (block: { id: string; status: CorrectionStatus }) => ReactNode;
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

function renderInline(node: BlockTreeNode, key: string): ReactNode {
  if (node.type === 'text') {
    return <span key={key}>{applyMarks(node.text ?? '', node.marks)}</span>;
  }
  return renderNode(node, key);
}

function renderChildren(node: BlockTreeNode): ReactNode[] {
  return (node.content ?? []).map((child, idx) => renderInline(child, `${node.type}-${idx}`));
}

function renderNode(node: BlockTreeNode, key: string): ReactNode {
  const attrs = asRecord(node.attrs);
  if (node.type === 'paragraph') return <p key={key}>{renderChildren(node)}</p>;
  if (node.type === 'heading') {
    const level = attrs.level === 2 || attrs.level === 3 || attrs.level === 4 ? attrs.level : 3;
    const HeadingTag = `h${level}` as 'h2' | 'h3' | 'h4';
    return <HeadingTag key={key}>{renderChildren(node)}</HeadingTag>;
  }
  if (node.type === 'bulletList') return <ul key={key}>{renderChildren(node)}</ul>;
  if (node.type === 'orderedList') return <ol key={key}>{renderChildren(node)}</ol>;
  if (node.type === 'listItem') return <li key={key}>{renderChildren(node)}</li>;
  if (node.type === 'hardBreak') return <br key={key} />;
  if (node.type === CROSS_LINK_BLOCK_NODE) {
    return (
      <div key={key} className="block-tree-link-card">
        <span>cross_link</span>
        <strong>{String(attrs.title ?? attrs.artifact_id ?? 'Artifact')}</strong>
        {attrs.block_id ? <small>#{String(attrs.block_id)}</small> : null}
      </div>
    );
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
        {renderChildren(node)}
      </aside>
    );
  }
  if (node.type === AUTO_LINKS_CONTAINER_NODE) {
    return (
      <aside key={key} className="block-tree-auto-links">
        <strong>{String(attrs.title ?? 'Related')}</strong>
        {renderChildren(node)}
      </aside>
    );
  }
  return (
    <div key={key} className="block-tree-unknown">
      {renderChildren(node)}
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
}: BlockTreeRendererProps) {
  const subjectModel = resolveSubjectRenderModel(subjectProfile);
  const bodyProps = subjectContentProps(subjectModel, { className: 'artifact-section-body' });
  const notation = (subjectModel.renderConfig.notation ?? undefined) as
    | 'latex'
    | 'wenyan'
    | 'plaintext'
    | 'code'
    | undefined;

  return (
    <div className="artifact-sections block-tree-renderer">
      {(bodyBlocks.content as BlockTreeNode[] | undefined)?.map((node, index) => {
        if (node.type !== SEMANTIC_BLOCK_NODE) {
          return renderNode(node, `node-${index}`);
        }
        const attrs = asRecord(node.attrs) as unknown as SemanticBlockAttrs;
        const id = typeof attrs.id === 'string' ? attrs.id : `block_${index}`;
        const kind = attrs.semantic_kind ?? 'definition';
        const sourceTier = attrs.source_tier ?? 'llm_only';
        const status = correctionBlocks[id] ?? ACTIVE_STATUS;
        const label = statusLabel(status);
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
            <div {...bodyProps}>
              {(node.content ?? []).map((child, idx) => renderNode(child, `${id}-${idx}`))}
            </div>
            {kind === 'check' ? (
              <EmbeddedCheckSection
                status={embeddedCheckStatus}
                questions={embeddedQuestions}
                notation={notation}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
