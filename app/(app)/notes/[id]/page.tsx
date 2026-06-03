'use client';

import type { ArtifactHistoryEntryT } from '@/core/schema/business';
import { ArtifactBlockTree } from '@/ui/block-tree/ArtifactBlockTree';
import { BlockTreeRenderer } from '@/ui/block-tree/BlockTreeRenderer';
import { type BlockTreeDoc, type BlockTreeNode, SEMANTIC_BLOCK_NODE } from '@/ui/block-tree/types';
import type {
  ArtifactEmbeddedCheckStatus,
  ArtifactSection,
  EmbeddedCheckQuestion,
} from '@/ui/components/ArtifactSections';
import { NoteRenderer, VerificationBadge } from '@/ui/components/NoteRenderer';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { deriveNoteActorView } from '@/ui/lib/note-actor';
import type { SlimSubjectProfile } from '@/ui/lib/subject';
import { formatRelTime } from '@/ui/lib/utils';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';

type VerificationStatus =
  | 'not_required'
  | 'not_started'
  | 'queued'
  | 'verified'
  | 'needs_review'
  | 'failed';

interface NoteVerificationIssue {
  block_id: string | null;
  severity: 'info' | 'warn' | 'error';
  category: 'factuality' | 'coverage' | 'clarity' | 'subject_fit' | 'format' | 'safety';
  message: string;
  suggested_fix_md?: string;
}

interface NoteVerificationSummary {
  verdict: 'pass' | 'needs_review';
  summary_md: string;
  issues: NoteVerificationIssue[];
  confidence: number;
}

interface NoteLabel {
  id: string;
  name: string;
}

interface NoteBacklink {
  from_artifact_id: string;
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
}

interface RelatedItem {
  id: string;
  title: string;
  status: string;
  relation: 'primary' | 'label';
}

interface HistoryEntry {
  version: number;
  at: string;
  by?: { by?: string; task_kind?: string; model?: string };
  summary_md?: string;
}

interface NotePageData {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  labels: NoteLabel[];
  body_blocks: BlockTreeDoc | null;
  sections: ArtifactSection[];
  generation_status: string;
  verification_status: VerificationStatus;
  verification_summary: NoteVerificationSummary | null;
  embedded_check_status: ArtifactEmbeddedCheckStatus;
  embedded_questions: EmbeddedCheckQuestion[];
  subject_profile: SlimSubjectProfile;
  version: number;
  history: HistoryEntry[];
  backlinks: NoteBacklink[];
  backlinks_by_type: Record<string, NoteBacklink[]>;
  related_learning_items: RelatedItem[];
  created_at: string;
  updated_at: string;
}

interface EntryContext {
  kind: 'knowledge' | 'item';
  id: string;
}
type ViewMode = 'read' | 'edit';

const NOTE_TYPE_LABEL: Record<string, string> = {
  note_atomic: 'Atomic note',
  note_hub: 'Hub note',
  note_long: 'Long note',
};

const KIND_LABEL: Record<string, string> = {
  definition: '定义',
  mechanism: '机制',
  example: '例',
  pitfall: '易错',
  check: '自检',
};

// Outline rows are built ONLY for top-level `semanticBlock` nodes: those are the
// only nodes BlockTreeRenderer anchors with `data-block-id` (see its semanticBlock
// branch), so they are the only scroll targets the outline can resolve. Other
// top-level node types render without an anchor and are intentionally omitted so
// the outline never produces a dead click. The monospace glyph badge ahead of
// each row is keyed by semantic_kind (default '·' for unmapped/absent kinds).
const OUTLINE_GLYPH: Record<string, string> = {
  definition: '定',
  mechanism: '机',
  example: '例',
  pitfall: '易',
  check: '检',
};

function semanticKindOf(node: BlockTreeNode): string | undefined {
  const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
  const kind = (attrs as { semantic_kind?: unknown }).semantic_kind;
  return typeof kind === 'string' ? kind : undefined;
}

function outlineGlyph(node: BlockTreeNode): string {
  const kind = semanticKindOf(node);
  return (kind ? OUTLINE_GLYPH[kind] : undefined) ?? '·';
}

function parseEntryContext(raw: string | null): EntryContext | null {
  if (!raw) return null;
  const [kind, ...rest] = raw.split(':');
  const id = rest.join(':').trim();
  if (!id) return null;
  if (kind === 'knowledge') return { kind, id };
  if (kind === 'item') return { kind, id };
  return null;
}

function nodeText(node: BlockTreeNode | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map((child) => nodeText(child)).join(' ');
}

function nodeId(node: BlockTreeNode, index: number): string {
  const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
  const id = (attrs as { id?: unknown }).id;
  // Fallback MUST match BlockTreeRenderer's semanticBlock fallback (`block_${index}`,
  // underscore) so the outline scroll target resolves when a block lacks attrs.id.
  return typeof id === 'string' && id.length > 0 ? id : `block_${index}`;
}

function nodeLabel(node: BlockTreeNode, index: number): string {
  const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
  const semanticKind = (attrs as { semantic_kind?: unknown }).semantic_kind;
  const title = nodeText(node).trim().replace(/\s+/g, ' ');
  if (typeof semanticKind === 'string') {
    const prefix = KIND_LABEL[semanticKind] ?? semanticKind;
    return title ? `${prefix} · ${title.slice(0, 42)}` : prefix;
  }
  if (node.type === 'heading') return title || `标题 ${index + 1}`;
  if (node.type === 'crossLinkBlock') {
    const linkTitle = (attrs as { title?: unknown }).title;
    return `链接 · ${typeof linkTitle === 'string' ? linkTitle : 'Artifact'}`;
  }
  return title ? title.slice(0, 48) : `Block ${index + 1}`;
}

function outlineEntries(bodyBlocks: BlockTreeDoc | null) {
  // Keep the original content index (it must match BlockTreeRenderer's own
  // `.map((node, index))` index for the `block_${index}` anchor fallback), then
  // drop everything that isn't an anchorable semanticBlock.
  return ((bodyBlocks?.content ?? []) as BlockTreeNode[])
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === SEMANTIC_BLOCK_NODE)
    .map(({ node, index }) => ({
      id: nodeId(node, index),
      glyph: outlineGlyph(node),
      label: nodeLabel(node, index),
    }));
}

function scrollToBlock(id: string) {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(id)
      : id.replace(/"/g, '\\"');
  const target = document.querySelector(`[data-block-id="${escaped}"]`);
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function entryHref(entry: EntryContext | null): string {
  if (entry?.kind === 'knowledge') return `/knowledge/${entry.id}`;
  if (entry?.kind === 'item') return `/learning-items/${entry.id}`;
  return '/knowledge';
}

function entryText(entry: EntryContext | null, note: NotePageData): string | null {
  if (entry?.kind === 'knowledge') {
    return note.labels.find((label) => label.id === entry.id)?.name ?? entry.id;
  }
  if (entry?.kind === 'item') {
    return note.related_learning_items.find((item) => item.id === entry.id)?.title ?? entry.id;
  }
  return null;
}

export default function NoteReaderPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const id = params.id;
  const entry = parseEntryContext(searchParams.get('from'));
  const [mode, setMode] = useState<ViewMode>('read');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);

  const noteQ = useQuery({
    queryKey: ['note-page', id],
    queryFn: () => apiJson<NotePageData>(`/api/notes/${id}`),
    enabled: !!id,
  });

  const note = noteQ.data;
  const outline = useMemo(() => outlineEntries(note?.body_blocks ?? null), [note?.body_blocks]);

  // Mobile drawer focus management (a11y): trap Tab within the open drawer,
  // focus its first control on open, restore + Esc-to-close on close. Hooks must
  // run before the loading/error early return below to keep call order stable.
  const outlineDrawerRef = useRef<HTMLDivElement | null>(null);
  const ctxDrawerRef = useRef<HTMLDivElement | null>(null);
  const closeOutline = useCallback(() => setOutlineOpen(false), []);
  const closeCtx = useCallback(() => setCtxOpen(false), []);
  useFocusTrap(outlineOpen, closeOutline, outlineDrawerRef);
  useFocusTrap(ctxOpen, closeCtx, ctxDrawerRef);

  // loading / error / not-found states share the loom topbar back-link + a
  // Stateful body (skeleton / error retry / empty), matching the prototype's
  // ds-gated shell.
  if (noteQ.isLoading || noteQ.isError || !note) {
    const status = noteQ.isLoading ? 'loading' : noteQ.isError ? 'error' : 'empty';
    const errorText =
      noteQ.error instanceof ApiAuthError
        ? `${noteQ.error.message} — 请重新进入页面输入 token`
        : noteQ.isError
          ? `加载失败：${(noteQ.error as Error).message}`
          : '笔记加载失败。';
    return (
      <div className="note-reader-page">
        <div className="note-topbar">
          <Link href={entryHref(entry)} className="btn btn-quiet btn-sm">
            <LoomIcon name="arrowL" size={14} />
            {entry?.kind === 'item'
              ? '返回学习项'
              : entry?.kind === 'knowledge'
                ? '返回知识点'
                : '知识'}
          </Link>
          <span className="meta mono note-id-pill">/notes/{id}</span>
        </div>
        <div className="note-doc-col" style={{ paddingTop: 'var(--s-6)' }}>
          <Stateful
            status={status}
            skeleton={<SkLines rows={6} />}
            errorText={errorText}
            onRetry={() => noteQ.refetch()}
            empty={<EmptyState icon="doc" title="笔记不存在" text="该笔记可能已被删除或合并。" />}
          >
            <div />
          </Stateful>
        </div>
      </div>
    );
  }

  const entryLabel = entryText(entry, note);
  const entryCount = note.labels.length + note.related_learning_items.length;
  // A ready note is editable even with an empty body — ArtifactBlockTree accepts
  // a null bodyBlocks (it coerces to an empty doc) so the user can author the
  // first block instead of being stuck on a read-only "暂无正文" dead end.
  const canEdit = note.generation_status === 'ready';
  // note.history arrives JSON-serialized (at: ISO string); deriveNoteActorView
  // is runtime-safe for both Date and string `at` and casts the loose wire shape
  // to the schema type at the boundary.
  const actorView = deriveNoteActorView(note.history as unknown as ArtifactHistoryEntryT[]);
  // Version timeline, newest-first. Every edit appends a history row whose
  // `version` equals the new `artifact.version` in lockstep, so the newest
  // history entry already IS the current version — render from history and mark
  // its newest row as 当前. Only fall back to a synthetic current row when history
  // is empty (never-edited note), or defensively when it doesn't cover the
  // current version; otherwise the current version would render twice.
  const versionsDesc = actorView.versions.slice().reverse();
  const historyCoversCurrent = versionsDesc[0]?.version === note.version;

  const Outline = (
    <nav className="note-outline" aria-label="笔记大纲">
      <div className="note-rail-h">
        <LoomIcon name="panelLeft" size={14} />
        大纲 · block tree
      </div>
      <button
        type="button"
        className="nol-item nol-top"
        onClick={() => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          setOutlineOpen(false);
        }}
      >
        <span className="nol-glyph mono">⌂</span>
        <span className="nol-label">文档顶部</span>
      </button>
      {outline.map((item) => (
        <button
          type="button"
          key={item.id}
          className="nol-item"
          onClick={() => {
            scrollToBlock(item.id);
            setOutlineOpen(false);
          }}
        >
          <span className="nol-glyph mono">{item.glyph}</span>
          <span className="nol-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );

  const Context = (
    <aside className="note-context" aria-label="笔记上下文">
      {/* 属性 */}
      <div className="drawer-sec">
        <h4>
          <LoomIcon name="doc" size={13} /> 属性
        </h4>
        <div className="note-prop-row">
          <span className="meta">状态</span>
          <VerificationBadge
            status={note.verification_status}
            summary={note.verification_summary?.summary_md}
            issues={note.verification_summary?.issues ?? []}
          />
        </div>
        <div className="note-prop-row">
          <span className="meta">类型</span>
          <span>{NOTE_TYPE_LABEL[note.type] ?? note.type}</span>
        </div>
        <div className="note-prop-row">
          <span className="meta">更新</span>
          <span>{formatRelTime(new Date(note.updated_at))}</span>
        </div>
        {actorView.author && (
          <div className="note-prop-row">
            <span className="meta">作者</span>
            <span className="mono">
              <LoomIcon name={actorView.author.icon as LoomIconName} size={12} />{' '}
              {actorView.author.label}
            </span>
          </div>
        )}
        <div className="note-prop-row">
          <span className="meta">块数</span>
          <span className="mono tnum">{outline.length}</span>
        </div>
      </div>

      {/* 被这些 knowledge 标签命中 */}
      <div className="drawer-sec">
        <h4>
          <LoomIcon name="link" size={13} /> 被这些 knowledge 标签命中 · {note.labels.length}
        </h4>
        {note.labels.length === 0 ? (
          <div className="meta">暂无 knowledge 标签</div>
        ) : (
          <div className="note-label-list">
            {note.labels.map((label) => (
              <Link
                key={label.id}
                href={`/knowledge/${label.id}`}
                className={`note-label-row${
                  entry?.kind === 'knowledge' && entry.id === label.id ? ' is-entry' : ''
                }`}
              >
                <span className="chip chip-k mono">{label.id}</span>
                <span className="wenyan">{label.name}</span>
                {entry?.kind === 'knowledge' && entry.id === label.id && (
                  <span className="entry-tag mono">入口</span>
                )}
                <LoomIcon name="arrow" size={13} className="thread-arrow" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 相关学习项 */}
      <div className="drawer-sec">
        <h4>
          <LoomIcon name="items" size={13} /> 相关学习项 · {note.related_learning_items.length}
        </h4>
        {note.related_learning_items.length === 0 ? (
          <div className="meta">暂无共享标签的学习项</div>
        ) : (
          <div className="note-label-list">
            {note.related_learning_items.map((item) => (
              <Link
                key={item.id}
                href={`/learning-items/${item.id}`}
                className={`note-label-row${
                  entry?.kind === 'item' && entry.id === item.id ? ' is-entry' : ''
                }`}
              >
                <span className={`badge tone-${item.relation === 'primary' ? 'coral' : 'info'}`}>
                  <LoomIcon name="items" size={12} />
                </span>
                <span className="wenyan">{item.title}</span>
                {entry?.kind === 'item' && entry.id === item.id && (
                  <span className="entry-tag mono">入口</span>
                )}
                <LoomIcon name="arrow" size={13} className="thread-arrow" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 反向链接 — 额外保留（后端 backlinks_by_type，prototype NoteReader 无此区，
          但 codex 现页有，撑得起就不丢，见 pre-flight §4 缺口 5）。 */}
      <div className="drawer-sec">
        <h4>
          <LoomIcon name="reverse" size={13} /> 反向链接 · {note.backlinks.length}
        </h4>
        {note.backlinks.length === 0 ? (
          <div className="meta">暂无反向链接</div>
        ) : (
          <div className="note-label-list">
            {note.backlinks.map((backlink) => {
              const href = backlink.from_learning_item_id
                ? `/learning-items/${backlink.from_learning_item_id}`
                : backlink.from_type.startsWith('note_')
                  ? `/notes/${backlink.from_artifact_id}`
                  : null;
              const key = `${backlink.from_artifact_id}:${backlink.from_block_id}`;
              return href ? (
                <Link key={key} href={href} className="note-label-row">
                  <span className="wenyan">{backlink.from_title}</span>
                  <span className="badge tone-neutral mono">{backlink.from_type}</span>
                  <LoomIcon name="arrow" size={13} className="thread-arrow" />
                </Link>
              ) : (
                <div key={key} className="note-label-row" style={{ cursor: 'default' }}>
                  <span className="wenyan">{backlink.from_title}</span>
                  <span className="badge tone-neutral mono">{backlink.from_type}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 活动 · 版本 */}
      <div className="drawer-sec">
        <h4>
          <LoomIcon name="history" size={13} /> 活动 · 版本
        </h4>
        <div className="note-versions">
          {!historyCoversCurrent && (
            <div className="note-ver is-current">
              <span className="note-ver-dot" />
              <div className="note-ver-body">
                <div className="note-ver-top">
                  <span className="mono note-ver-v">v{note.version}</span>
                  <span className="meta" style={{ marginLeft: 'auto' }}>
                    当前 · {formatRelTime(new Date(note.updated_at))}
                  </span>
                </div>
              </div>
            </div>
          )}
          {versionsDesc.map((v, i) => {
            const isCurrent = historyCoversCurrent && i === 0;
            return (
              <div
                key={`${v.version}:${v.at}`}
                className={`note-ver${isCurrent ? ' is-current' : ''}`}
              >
                <span className="note-ver-dot" />
                <div className="note-ver-body">
                  <div className="note-ver-top">
                    <span className="mono note-ver-v">v{v.version}</span>
                    <span className="mono">
                      <LoomIcon name={v.actorIcon as LoomIconName} size={11} /> {v.actorLabel}
                    </span>
                    <span className="meta" style={{ marginLeft: 'auto' }}>
                      {isCurrent ? '当前 · ' : ''}
                      {formatRelTime(new Date(v.at))}
                    </span>
                  </div>
                  {v.note && <div className="note-ver-note">{v.note}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );

  return (
    <div className="note-reader-page">
      {/* top sub-bar */}
      <div className="note-topbar">
        <Link href={entryHref(entry)} className="btn btn-quiet btn-sm">
          <LoomIcon name="arrowL" size={14} />
          {entry?.kind === 'item'
            ? '返回学习项'
            : entry?.kind === 'knowledge'
              ? '返回知识点'
              : '知识'}
        </Link>
        <span className="meta mono note-id-pill">/notes/{note.id}</span>
        <div className="topbar-spacer" />
        <IconBtn
          icon="panelLeft"
          size={16}
          className="note-rail-toggle"
          title="大纲"
          aria-label="切换大纲"
          aria-expanded={outlineOpen}
          aria-controls="note-outline-drawer"
          onClick={() => setOutlineOpen((o) => !o)}
        />
        <div
          className="seg-row note-mode"
          role="tablist"
          aria-label="笔记模式"
          style={{ margin: 0 }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'read'}
            className={`seg seg-sm${mode === 'read' ? ' is-on' : ''}`}
            onClick={() => setMode('read')}
          >
            <LoomIcon name="eye" size={14} /> 阅读
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={`seg seg-sm${mode === 'edit' ? ' is-on' : ''}`}
            onClick={() => setMode('edit')}
            disabled={!canEdit}
          >
            <LoomIcon name="pencil" size={14} /> 编辑
          </button>
        </div>
        <IconBtn
          icon="panelRight"
          size={16}
          className="note-rail-toggle"
          title="上下文"
          aria-label="切换上下文"
          aria-expanded={ctxOpen}
          aria-controls="note-context-drawer"
          onClick={() => setCtxOpen((o) => !o)}
        />
      </div>

      <div className="note-reader-grid">
        <div className="note-rail-left">{Outline}</div>

        <main className="note-doc-col">
          {/* one-note-many-entries banner */}
          {entryLabel && (
            <div className="note-entry-banner">
              <LoomIcon name="link" size={15} />
              <span>
                你经由{' '}
                <b>
                  {entry?.kind === 'knowledge' ? '知识点' : '学习项'} {entryLabel}
                </b>{' '}
                打开这篇笔记 · 同一篇笔记另有 <b>{Math.max(0, entryCount - 1)}</b> 个入口
              </span>
            </div>
          )}

          {/* in-page title (NOT inside a card) */}
          <header className="note-doc-head">
            <div className="note-doc-eyebrow mono">
              NOTE · {note.id} · {note.labels.map((l) => l.id).join(' / ') || 'labels[]'}
            </div>
            <h1 className="note-doc-title serif">{note.title}</h1>
            <div className="note-doc-meta">
              {note.labels.map((label) => (
                <Link
                  key={label.id}
                  href={`/knowledge/${label.id}`}
                  className={entry?.kind === 'knowledge' && entry.id === label.id ? 'is-entry' : ''}
                >
                  <LoomIcon name="link" size={11} /> {label.name}
                </Link>
              ))}
              <VerificationBadge
                status={note.verification_status}
                summary={note.verification_summary?.summary_md}
                issues={note.verification_summary?.issues ?? []}
              />
              <span className="meta">
                更新 {formatRelTime(new Date(note.updated_at))}
                {actorView.author && ` · ${actorView.author.label}`}
              </span>
            </div>
          </header>

          {/* entry-points strip — makes "same note, many doors" explicit */}
          <div className="note-entries-strip">
            <span className="meta">入口 · {entryCount}</span>
            {note.labels.map((label) => (
              <Link
                key={label.id}
                href={`/knowledge/${label.id}`}
                className={`entry-pill${
                  entry?.kind === 'knowledge' && entry.id === label.id ? ' is-here' : ''
                }`}
              >
                <LoomIcon name="knowledge" size={12} />
                {label.name}
              </Link>
            ))}
            {note.related_learning_items.map((item) => (
              <Link
                key={item.id}
                href={`/learning-items/${item.id}`}
                className={`entry-pill${
                  entry?.kind === 'item' && entry.id === item.id ? ' is-here' : ''
                }`}
              >
                <LoomIcon name="items" size={12} />
                {item.title}
              </Link>
            ))}
          </div>

          {note.generation_status !== 'ready' && (
            <div className="note-reader-status">generation_status: {note.generation_status}</div>
          )}

          {mode === 'read' ? (
            note.body_blocks ? (
              <BlockTreeRenderer
                bodyBlocks={note.body_blocks}
                subjectProfile={note.subject_profile}
                embeddedQuestions={note.embedded_questions}
                embeddedCheckStatus={note.embedded_check_status}
              />
            ) : (
              <p className="note-reader-muted">这篇笔记暂无正文。</p>
            )
          ) : (
            <div className="note-edit-shell">
              <div className="meta" style={{ marginBottom: 'var(--s-3)' }}>
                <LoomIcon name="pencil" size={12} /> 编辑模式 · 悬停块显示拖拽手柄与 / 插入
              </div>
              <ArtifactBlockTree
                artifactId={note.id}
                artifactVersion={note.version}
                bodyBlocks={note.body_blocks}
                sections={note.sections}
                subjectProfile={note.subject_profile}
                embeddedQuestions={note.embedded_questions}
                embeddedCheckStatus={note.embedded_check_status}
                onArtifactSaved={() =>
                  queryClient.invalidateQueries({ queryKey: ['note-page', id] })
                }
                onSectionSaved={() =>
                  queryClient.invalidateQueries({ queryKey: ['note-page', id] })
                }
              />
            </div>
          )}

          {note.verification_summary && (
            <section className="note-reader-verification">
              <div className="note-section-kicker mono">校验摘要</div>
              <NoteRenderer kind="verification">
                {note.verification_summary.summary_md}
              </NoteRenderer>
            </section>
          )}
        </main>

        <div className="note-rail-right">{Context}</div>
      </div>

      {/* mobile drawers */}
      {outlineOpen && (
        <button
          type="button"
          className="scrim open"
          aria-label="关闭大纲"
          onClick={() => setOutlineOpen(false)}
        />
      )}
      <div
        ref={outlineDrawerRef}
        id="note-outline-drawer"
        // biome-ignore lint/a11y/useSemanticElements: CSS-class-driven drawer (.open
        // toggle + custom useFocusTrap), not a native <dialog>; role="dialog" +
        // aria-modal is the correct ARIA for this modal pattern.
        role="dialog"
        aria-modal="true"
        aria-label="笔记大纲"
        className={`note-mobile-drawer left${outlineOpen ? ' open' : ''}`}
      >
        {Outline}
      </div>
      {ctxOpen && (
        <button
          type="button"
          className="scrim open"
          aria-label="关闭上下文"
          onClick={() => setCtxOpen(false)}
        />
      )}
      <div
        ref={ctxDrawerRef}
        id="note-context-drawer"
        // biome-ignore lint/a11y/useSemanticElements: CSS-class-driven drawer (.open
        // toggle + custom useFocusTrap), not a native <dialog>; role="dialog" +
        // aria-modal is the correct ARIA for this modal pattern.
        role="dialog"
        aria-modal="true"
        aria-label="笔记上下文"
        className={`note-mobile-drawer right${ctxOpen ? ' open' : ''}`}
      >
        {Context}
      </div>
    </div>
  );
}
