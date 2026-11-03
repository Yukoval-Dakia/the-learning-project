// M3 笔记面 — 阅读器宿主（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-note-reader.jsx：三栏
//（大纲 rail / 正文 / Context 右栏四区：属性 · labels 命中 · 相关学习项 ·
// 活动版本）+ topbar（返回入口感知 + /notes/{id} pill + 阅读/编辑 seg）。
// 编辑保存 = PATCH body-blocks 乐观锁（409 → 提示刷新，pre-flight B 偏离②）；
// AI refine 痕迹与 undo 接 ai-changes 链（T5 已验真）。
// M3E presentation (YUK-1473, docs/design/2026-11-03-notes-m3e.md): only the markup and styles
// changed (toasts now go through the ui-next toast host); queries, save/undo, the presence
// lease, the draft snapshot, deep links and error handling are as before.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Eye,
  FileText,
  Link,
  ListChecks,
  PanelLeft,
  Pencil,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { InteractiveArtifactRenderer } from '@/ui/components/InteractiveArtifactRenderer';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { undoAiChange } from '@/ui/lib/undo-ai-change';
import { invalidateAfterAiChangeUndo, queryKeys } from '@/ui/lib/write-invalidation';
import { ToastHost } from '@/ui-next/feedback/ToastHost';
import { showToast } from '@/ui-next/feedback/toast-store';
import { ChipButton } from '@/ui-next/primitives/Chip';
import { FoldList } from '@/ui-next/primitives/FoldList';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SectionHead } from '@/ui-next/primitives/SectionHead';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, IconButton, UiNextRoot } from '@/ui-next/public';
import './notes-m3e.css';

import { NoteBlockView, blockOutlineLabel, questionDetailHref } from './NoteBlocks';
import { NoteEditor } from './NoteEditor';
import { NoteEmpty } from './NoteEmpty';
import {
  type BodyBlock,
  SEMANTIC_KIND_LABEL,
  type SemanticKind,
  editingBlur,
  editingHeartbeat,
  getAiChanges,
  getNotePage,
  questionsForKnowledge,
  saveBodyBlocks,
  searchArtifacts,
} from './notes-api';

const NOTE_TYPE_LABEL: Record<string, string> = {
  note_atomic: '短笔记',
  note_hub: '汇总笔记',
  note_long: '长文笔记',
  interactive: '互动内容',
};

// The page frame shared by every state: M3E scope, the M3 role bridge and the toast host.
function ReaderFrame({ children }: { children: ReactNode }) {
  return (
    <UiNextRoot className="nt-page">
      <main className="nt-reader-main un-m3e-bridge">{children}</main>
      <ToastHost />
    </UiNextRoot>
  );
}

function VerifyChip({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <Chip tone="positive">
        <Check size={12} aria-hidden="true" />
        已校验
      </Chip>
    );
  }
  return (
    <Chip>
      <Sparkles size={12} aria-hidden="true" />
      草稿
    </Chip>
  );
}

// Outline glyph: @ for a cross link, ? for a question reference, a dot for prose.
function outlineGlyph(b: BodyBlock): string {
  if (b.type === 'crossLinkBlock') return '@';
  if (b.type === 'questionRefBlock') return '?';
  return '·';
}

function changeActorLabel(actorRef: string): string {
  return actorRef === 'user' || actorRef.startsWith('user:') ? '你' : 'AI';
}

// Safely coerce any rejection to a string (a non-Error value must not make the handler
// itself throw).
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Optimistic-lock conflict detection shared by the save + undo error paths (undo raises a
// synthetic 409 for the version_conflict status).
function isVersionConflict(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 409) return true;
  const msg = errMessage(e);
  return msg.includes('409') || msg.includes('conflict');
}

// YUK-339 — 块锚点深链（设计源 NoteReaderBody anchor()，screen-note-reader.jsx:36-40）。
// hash-only pushState：地址栏变为可分享的 #nb-<blockId>（保留 ?entry= 入口上下文），
// 不触发 router 导航也不引发原生锚点瞬跳；滚动交给 scrollIntoView + notes-m3e.css
// .nt-blk 的 scroll-margin-top(84px)（与设计源 scrollTop-84 同源，无 JS 硬编码）。
function jumpToBlockAnchor(anchorId: string) {
  window.history.pushState(null, '', `#${anchorId}`);
  document.getElementById(anchorId)?.scrollIntoView({ behavior: 'smooth' });
}

// 编辑期 presence（M5 全分支 review H2 接线）：编辑态每 5s 心跳，worker 的
// note-refine 据此 defer AI patch（ADR-0023 不变量）；离开编辑态（切回阅读 /
// 保存成功 / 换笔记 / 卸载）blur——服务端置 idle 并 FIFO flush 被 defer 的
// patch。best-effort：presence 失败不打断编辑（与旧 ArtifactBlockTree 等价），
// 兜底是 30s 心跳超时 sticky idle + PATCH 乐观锁。
// YUK-384 — one editor_session_id per edit session, so the server keys presence
// by (artifact, session). Minted on acquire, reused for every heartbeat and for
// the blur; a later edit session mints a fresh id.
//
// This is a write lease, owned per reader instance (no module state). Release is
// deferred one tick: a detach immediately followed by a re-attach for the same
// artifact (StrictMode's simulated remount, or React re-running the ref callback)
// keeps the same session instead of blurring and minting a second one.
function createEditingPresence(
  sendHeartbeat: typeof editingHeartbeat,
  sendBlur: typeof editingBlur,
) {
  type Lease = { artifactId: string; sessionId: string; heartbeat: number };
  let lease: Lease | null = null;
  let attachedArtifact: string | null = null;
  let pendingRelease: number | null = null;
  let listening = false;

  const end = () => {
    const ended = lease;
    if (!ended) return;
    lease = null;
    window.clearInterval(ended.heartbeat);
    // Document navigation need not unmount React. Keep the authenticated blur
    // eligible to finish after pagehide; server expiry remains the fallback.
    void sendBlur(ended.artifactId, ended.sessionId).catch(() => {});
  };

  const begin = (artifactId: string) => {
    if (lease?.artifactId === artifactId) return;
    end();
    const sessionId = randomId();
    const beat = () => {
      void sendHeartbeat(artifactId, sessionId).catch(() => {});
    };
    lease = { artifactId, sessionId, heartbeat: window.setInterval(beat, 5000) };
    beat();
  };

  const onPageHide = () => end();
  const onPageShow = () => {
    // A bfcache restoration keeps the mounted editor and its draft, but the old
    // session was released. Rejoin with a new identity, never revive that lease.
    if (attachedArtifact) begin(attachedArtifact);
  };

  return {
    acquire(artifactId: string) {
      if (pendingRelease !== null) {
        window.clearTimeout(pendingRelease);
        pendingRelease = null;
      }
      attachedArtifact = artifactId;
      if (!listening) {
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);
        listening = true;
      }
      begin(artifactId);
    },
    release() {
      attachedArtifact = null;
      if (pendingRelease !== null) return;
      pendingRelease = window.setTimeout(() => {
        pendingRelease = null;
        end();
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        listening = false;
      }, 0);
    },
  };
}

// 每块发 nt-blk-{type} 类；非 section 块型映射到同语义短类。section 块固定
// .nt-blk-section（notes-m3e.css 的 gutter 常亮规则锚定它）。
const BLOCK_KIND_CLASS: Record<string, string> = {
  semanticBlock: 'nt-blk-plain',
  crossLinkBlock: 'nt-blk-cross',
  questionRefBlock: 'nt-blk-qref',
};

// 小节标题：semanticBlock 的 kind 标签（五段式解剖与 bodyBlocksToNoteSections
// 1:1）。check 是不判分的自解释小节；kind 缺失/未知回退普通块。
function sectionKindLabel(b: BodyBlock): string | null {
  if (b.type !== 'semanticBlock') return null;
  const kind = b.attrs?.semantic_kind;
  if (typeof kind !== 'string') return null;
  return SEMANTIC_KIND_LABEL[kind as SemanticKind] ?? null;
}

export default function NoteReaderPage({
  id,
  navigate,
  read = getNotePage,
  save = saveBodyBlocks,
  readAiChanges = getAiChanges,
  undo = undoAiChange,
  searchReferences = searchArtifacts,
  readQuestions = questionsForKnowledge,
  sendHeartbeat = editingHeartbeat,
  sendBlur = editingBlur,
}: {
  id: string;
  navigate: (to: string) => void;
  read?: typeof getNotePage;
  save?: typeof saveBodyBlocks;
  readAiChanges?: typeof getAiChanges;
  undo?: typeof undoAiChange;
  searchReferences?: typeof searchArtifacts;
  readQuestions?: typeof questionsForKnowledge;
  sendHeartbeat?: typeof editingHeartbeat;
  sendBlur?: typeof editingBlur;
}) {
  const qc = useQueryClient();
  const noteQ = useQuery({ queryKey: queryKeys.notePage(id), queryFn: () => read(id) });
  const changesQ = useQuery({
    queryKey: queryKeys.noteAiChanges(id),
    queryFn: () => readAiChanges(id),
  });

  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [draft, setDraft] = useState<BodyBlock[] | null>(null);

  // S12 (YUK-335)：入口上下文——同一篇笔记从多个 knowledge 节点可达（设计「一篇
  // 笔记多扇门」）。read 态从 ?entry=<knowledge_id> 读当前入口。惰性初始化读一次，
  // 之后随 id 变化在下面 shownId 复位块重读：同一 /notes/$id 实例被复用时（正文交叉
  // 链跳别篇笔记不 remount——见 shownId adjust 块），若不重读会沿用旧 entry，在新笔记
  // 上误亮 banner / 返回链指向旧知识点（Codex #400 F3）。
  // 无 param → 无入口上下文（banner 不渲、strip 不高亮、返回链回退 labels[0]）。
  const [entryKid, setEntryKid] = useState(() =>
    new URLSearchParams(window.location.search).get('entry'),
  );

  const note = noteQ.data;
  const blocks = note?.body_blocks?.content ?? [];

  // 草稿只在进入编辑态时快照一次（见编辑 tab onClick）——不能依赖 note 对象：
  // query refetch（窗口聚焦/重连）会换引用，若挂 effect 会把未保存编辑静默覆盖。
  // 切换笔记 id 时复位为阅读态并丢弃草稿——render 期 adjust（React 官方
  // "adjusting state when a prop changes" 模式），避免 effect 迟一帧闪旧草稿。
  const [shownId, setShownId] = useState(id);
  if (shownId !== id) {
    setShownId(id);
    setMode('read');
    setDraft(null);
    // 换笔记时重读 ?entry（缺失→null），清掉上一篇的陈旧入口（Codex #400 F3）。
    setEntryKid(new URLSearchParams(window.location.search).get('entry'));
  }

  // Editing presence (see createEditingPresence). The lease is held while the NoteEditor node is attached (edit mode only):
  // attach acquires for this artifact, detach releases. See createEditingPresence
  // for why release is deferred by one tick.
  const [presence] = useState(() => createEditingPresence(sendHeartbeat, sendBlur));
  const editSessionRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      presence.acquire(id);
      return () => presence.release();
    },
    [presence, id],
  );

  // YUK-339 — 深链 → 块锚点滚动：URL 带 #nb-<blockId|index> 时，笔记数据到位后
  // 滚到该块。ref 守卫按笔记 id 只跑一次：窗口聚焦/重连 refetch 不会重挂正文列，
  // 守卫再挡住同篇重挂；换笔记 id 后新深链可再触发。正文列只在 note 到位后挂载，
  // 子块（含 #nb- 锚点）先于它 commit，所以 attach 时锚点已在 DOM。
  const deepLinkedNoteRef = useRef<string | null>(null);
  const docColumnRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node || deepLinkedNoteRef.current === id) return;
      deepLinkedNoteRef.current = id;
      const hash = window.location.hash;
      if (hash.startsWith('#nb-')) {
        document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
      }
    },
    [id],
  );

  const say = (text: string) => {
    showToast({ message: text });
  };

  // One conflict-detection rule for both mutations (see isVersionConflict) — the version
  // conflict copy, else an action-prefixed failure with the safely-coerced message.
  const conflictToast = (e: unknown, conflictMsg: string, failPrefix: string) => {
    say(isVersionConflict(e) ? conflictMsg : `${failPrefix}：${errMessage(e)}`);
  };

  const saveM = useMutation({
    mutationFn: () =>
      save(id, {
        artifact_version: note?.version ?? 0,
        body_blocks: { type: 'doc', content: draft ?? [] },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.notePage(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.noteAiChanges(id) });
      setMode('read');
      setDraft(null);
      say('已保存——版本推进，refine 痕迹照常累积。');
    },
    onError: (e) =>
      conflictToast(
        e,
        '版本冲突：这篇笔记在别处被改过（可能是 AI refine）——刷新后再编辑。',
        '保存失败',
      ),
  });

  const undoM = useMutation({
    mutationFn: (eventId: string) => undo(id, eventId),
    onSuccess: () => {
      // Also refreshes the workbench AI-changes strip.
      void invalidateAfterAiChangeUndo(qc, { artifactId: id });
      say('已还原该次 AI 修订。');
    },
    // undoAiChange raises a 409 on 'skipped:version_conflict' (a 200 that did NOT restore),
    // so this branch now catches the concurrent-drift case too (mirror saveM.onError).
    onError: (e) =>
      conflictToast(e, '版本冲突：这篇笔记在别处被改过——刷新后再试还原。', '还原失败'),
  });

  // S4 (YUK-335)：载态用与正文同形的骨架，空态带图形锚点与出路。
  if (noteQ.isLoading)
    return (
      <ReaderFrame>
        <div className="nt-reader-state">
          <SkeletonLines rows={6} label="正在打开笔记" />
        </div>
      </ReaderFrame>
    );
  // S4-fix (YUK-335)：error 态独立分支（设计源用 Stateful 三态）——否则瞬时 fetch
  // 失败会落进下面的 !note 分支，被误读成永久「笔记不存在」、且无重试入口。
  // 但 404（笔记不存在/已删）语义上是「空」非「加载失败」——让它落到下面
  // 的空态，只有瞬时错误（网络/5xx）才示重试行（视觉环实测：404 误显「加载失败」会
  // 反向坏了 not-found 态）。
  // 用 isLoadingError（= 出错且无缓存 data）而非 isError：笔记已加载后窗口聚焦/重连
  // 触发的后台 refetch 若失败，TanStack v5 保留旧 data 同时把 isError 置真
  // （isRefetchError）——只判 isError 会把仍可用的阅读/编辑界面（含未保存草稿）整页
  // 替换成重试行。isLoadingError 只在「无缓存的首次加载失败」时为真，refetch
  // 失败时为假 → 落到下面 !note=false 继续用缓存渲染，仅丢一次刷新（Codex #399 F1）。
  const isNotFound = noteQ.error instanceof ApiError && noteQ.error.status === 404;
  if (noteQ.isLoadingError && !isNotFound)
    return (
      <ReaderFrame>
        <div className="nt-reader-state">
          <RetryLine message="笔记加载失败。" onRetry={() => void noteQ.refetch()} />
        </div>
      </ReaderFrame>
    );
  if (!note)
    return (
      <ReaderFrame>
        <div className="nt-reader-state">
          <NoteEmpty
            icon={<FileText size={22} />}
            title="笔记不存在"
            text="这篇笔记不存在或已被归档。"
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/knowledge')}>
                <ArrowLeft size={16} aria-hidden="true" />
                返回知识
              </Button>
            }
          />
        </div>
      </ReaderFrame>
    );

  // S12 (YUK-335)：entryMatch = ?entry 严格命中的 label（有入口上下文时才 truthy，
  // 用于 banner 文案 + strip 当前入口反白）；entryLabel = 返回链/右栏入口
  // tag 的派生来源，命中则用命中 label，否则回退 labels[0]（无入口上下文也保返回链
  // 不空——返回链是导航兜底，不是入口断言）。
  const entryMatch = entryKid ? (note.labels.find((l) => l.id === entryKid) ?? null) : null;
  const entryLabel = entryMatch ?? note.labels[0] ?? null;
  const verified = note.verification_status === 'verified';
  const shown = mode === 'edit' ? (draft ?? []) : blocks;

  return (
    <ReaderFrame>
      <div className="nt-topbar">
        <button
          type="button"
          className="nt-back"
          onClick={() => navigate(entryLabel ? `/knowledge/${entryLabel.id}` : '/knowledge')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {entryLabel ? '返回知识点' : '知识'}
        </button>
        <span className="nt-topbar-spacer" />
        <IconButton
          className="nt-outline-toggle"
          label="大纲"
          icon={<PanelLeft size={16} />}
          aria-pressed={outlineOpen}
          onClick={() => setOutlineOpen((o) => !o)}
        />
        {/* Two plain buttons, not a radio group: arrow keys on a radio group would switch to
            阅读 and silently drop the unsaved draft. Click-only, as before. */}
        <fieldset className="nt-mode">
          <legend className="un-sr-only">阅读模式</legend>
          <button
            type="button"
            className="nt-mode-btn"
            aria-pressed={mode === 'read'}
            onClick={() => {
              // 切回阅读丢弃未保存改动（与保存成功路径一致）。
              setMode('read');
              setDraft(null);
            }}
          >
            <Eye size={14} aria-hidden="true" />
            阅读
          </button>
          <button
            type="button"
            className="nt-mode-btn"
            aria-pressed={mode === 'edit'}
            onClick={() => {
              // 进入编辑态时一次性快照服务端块；已在编辑中则保持现有草稿。
              setDraft((d) => d ?? note.body_blocks?.content ?? []);
              setMode('edit');
            }}
          >
            <Pencil size={14} aria-hidden="true" />
            编辑
          </button>
        </fieldset>
        {mode === 'edit' && (
          <Button
            size="sm"
            variant="primary"
            disabled={saveM.isPending}
            onClick={() => saveM.mutate()}
          >
            <Check size={16} aria-hidden="true" />
            {saveM.isPending ? '保存中…' : '保存'}
          </Button>
        )}
      </div>

      <div className="nt-grid" data-outline={outlineOpen ? 'open' : 'closed'}>
        {outlineOpen && (
          <nav className="nt-outline" aria-label="大纲">
            <div className="nt-rail-head">大纲</div>
            {shown.map((b, i) => (
              <button
                type="button"
                key={b.attrs?.id ?? i}
                className="nt-ol-item"
                onClick={() => {
                  document
                    .getElementById(`nb-${b.attrs?.id ?? i}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              >
                <span className="nt-ol-glyph" aria-hidden="true">
                  {outlineGlyph(b)}
                </span>
                <span className="nt-ol-label">{blockOutlineLabel(b)}</span>
              </button>
            ))}
          </nav>
        )}

        <article ref={docColumnRef} className="nt-doc-col">
          {/* S12 (YUK-335)：入口 banner——仅当 ?entry 命中某 label 时渲，无入口上下文
              不占版面。文案点明「从哪扇门进来」+ 同篇笔记另有几个入口。 */}
          {entryMatch && (
            <div className="nt-entry-banner">
              <Link size={16} aria-hidden="true" />
              <span>
                你从「<b>{entryMatch.name}</b>」进入这篇笔记
                {note.labels.length > 1 && (
                  <>
                    {' '}
                    · 同一篇笔记另有 <b>{note.labels.length - 1}</b> 个入口
                  </>
                )}
              </span>
            </div>
          )}
          <h1 className="nt-doc-title">{note.title}</h1>
          <div className="nt-doc-meta">
            <Chip>{NOTE_TYPE_LABEL[note.type] ?? '笔记'}</Chip>
            <VerifyChip verified={verified} />
            <span className="nt-doc-version">第 {note.version} 版</span>
          </div>

          {/* S12 (YUK-335)：入口 strip——「同一篇笔记多扇门」的主表达。遍历 note.labels
              每个 knowledge 标签出一个入口（点击 navigate 到该知识点）；?entry 命中的
              当前入口反白。仅 read 态渲（编辑态不占版面）。 */}
          {mode === 'read' && note.labels.length > 0 && (
            <div className="nt-entries">
              <span className="nt-entries-label">入口 · {note.labels.length}</span>
              {note.labels.map((l) => (
                <ChipButton
                  key={l.id}
                  tone={entryMatch?.id === l.id ? 'accent' : 'neutral'}
                  onClick={() => navigate(`/knowledge/${l.id}`)}
                >
                  <Link size={12} aria-hidden="true" />
                  {l.name}
                </ChipButton>
              ))}
            </div>
          )}

          {mode === 'edit' && draft ? (
            <NoteEditor
              blocks={draft}
              labels={note.labels}
              noteId={note.id}
              onChange={setDraft}
              rootRef={editSessionRef}
              searchReferences={searchReferences}
              readQuestions={readQuestions}
            />
          ) : (
            <NoteDocBody
              type={note.type}
              title={note.title}
              interactive={note.interactive}
              blocks={blocks}
              navigate={navigate}
              onOpenQuestion={(questionId) => navigate(questionDetailHref(questionId))}
            />
          )}
        </article>

        <aside className="nt-context" aria-label="笔记信息">
          <section className="nt-ctx-sec" aria-labelledby="nt-ctx-props">
            <SectionHead id="nt-ctx-props" title="属性" />
            <dl className="nt-props">
              <div className="nt-prop">
                <dt>状态</dt>
                <dd>
                  <VerifyChip verified={verified} />
                </dd>
              </div>
              <div className="nt-prop">
                <dt>版本</dt>
                <dd className="un-num">第 {note.version} 版</dd>
              </div>
              <div className="nt-prop">
                <dt>内容段</dt>
                <dd className="un-num">{blocks.length}</dd>
              </div>
            </dl>
          </section>

          <section className="nt-ctx-sec" aria-labelledby="nt-ctx-labels">
            <SectionHead
              id="nt-ctx-labels"
              title="关联知识点"
              aside={<span className="un-num">{note.labels.length}</span>}
            />
            <ul className="nt-ctx-list">
              {note.labels.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className="nt-ctx-row"
                    data-entry={entryMatch?.id === l.id || undefined}
                    onClick={() => navigate(`/knowledge/${l.id}`)}
                  >
                    {/* de-wenyan: label rows carry no domain on the wire → neutral
                        default font (subject-driven is a follow-up). */}
                    <span className="nt-ctx-name">{l.name}</span>
                    {/* S12 (YUK-335)：右栏「入口」tag 只在真有入口上下文（?entry 命中）
                        时显示——与顶部 strip 的当前入口同源 entryMatch，无 param 不误标。 */}
                    {entryMatch?.id === l.id && <Chip tone="accent">入口</Chip>}
                    <ChevronRight className="nt-ctx-arrow" size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="nt-ctx-sec" aria-labelledby="nt-ctx-items">
            <SectionHead
              id="nt-ctx-items"
              title="相关学习项"
              aside={<span className="un-num">{note.related_learning_items.length}</span>}
            />
            {note.related_learning_items.length === 0 ? (
              <p className="nt-ctx-empty">暂无关联相同知识点的学习项</p>
            ) : (
              <FoldList
                as="ul"
                className="nt-ctx-list"
                items={note.related_learning_items}
                renderItem={(it) => (
                  <li key={it.id} className="nt-ctx-item">
                    <ListChecks size={14} aria-hidden="true" />
                    {/* de-wenyan: related-item rows carry no domain → neutral default. */}
                    <span className="nt-ctx-name">{it.title}</span>
                    <span className="nt-ctx-note">暂不提供详情页</span>
                  </li>
                )}
              />
            )}
          </section>

          <section className="nt-ctx-sec" aria-labelledby="nt-ctx-changes">
            <SectionHead id="nt-ctx-changes" title="活动 · AI 修订" />
            {/* 最近 3 版在前，其余收进「全部 N 条」（owner 2026-10-18 折叠决定，设计 L5）。 */}
            <FoldList
              as="ol"
              className="nt-versions"
              items={changesQ.data?.rows ?? []}
              renderItem={(c) => (
                <li key={c.event_id} className="nt-ver" data-current={!c.undone || undefined}>
                  <span className="nt-ver-dot" aria-hidden="true" />
                  <div className="nt-ver-body">
                    <div className="nt-ver-top">
                      <span className="nt-ver-v">第 {c.next_artifact_version} 版</span>
                      <span className="nt-ver-actor">
                        <Sparkles size={12} aria-hidden="true" />
                        {changeActorLabel(c.actor_ref)}
                      </span>
                      <span className="nt-ver-time">
                        {new Date(c.created_at).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="nt-ver-note">
                      <span>
                        更新 {c.ops_count} 处 · 新增 {c.new_blocks} 段
                      </span>
                      {c.undone ? (
                        <Chip>已还原</Chip>
                      ) : (
                        <Button
                          size="sm"
                          variant="quiet"
                          className="nt-ver-undo"
                          disabled={undoM.isPending}
                          onClick={() => undoM.mutate(c.event_id)}
                        >
                          <Undo2 size={14} aria-hidden="true" />
                          还原
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              )}
            />
            {(changesQ.data?.rows ?? []).length === 0 && (
              <p className="nt-ctx-empty">暂无 AI 修订记录</p>
            )}
          </section>
        </aside>
      </div>
    </ReaderFrame>
  );
}

// ADR-0033 D5 — read-mode doc body. Pure presentational (no queries/state) so it
// is renderToString-testable on the node-only unit stack (AutoEnrolledPanel
// PanelBody precedent). Three render modes:
//   • type='interactive' + interactive non-null → sandboxed renderer (the
//     interactive artifact's body_blocks is always null, so it never reaches the
//     block branch).
//   • type='interactive' + interactive null → parse-fail degraded notice (the
//     server loaded the row but attrs.html failed its schema barrier; the page
//     still shows title/labels chrome instead of 404ing).
//   • note types → block list, or the empty-note prompt.
export function NoteDocBody({
  type,
  title,
  interactive,
  blocks,
  navigate,
  onOpenQuestion,
}: {
  type: string;
  title: string;
  interactive: { html: string } | null;
  blocks: BodyBlock[];
  navigate: (to: string) => void;
  onOpenQuestion: (questionId: string) => void;
}) {
  // YUK-339：section 折叠态（blockId → collapsed）。hook 必须在 interactive 早退
  // 分支之前——组件实例的 type 稳定，但 React 规则禁止条件调用 hook。初始渲染在
  // renderToString 下照常工作，ADR-0033 D5 的静态 HTML 测试不受影响。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = (blockId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  };

  if (type === 'interactive') {
    if (interactive) {
      return (
        <div className="nt-doc">
          <InteractiveArtifactRenderer html={interactive.html} title={title} />
        </div>
      );
    }
    return (
      <div className="nt-doc">
        <p className="nt-quiet">互动内容暂时无法渲染——这篇产物的内容未通过校验，已记录待修复。</p>
      </div>
    );
  }

  // S12 (YUK-335)：read 态正文用 .nt-body（17px 阅读字号）+
  // NoteBlockView variant="read"（crossLink 渲整宽链接卡）。interactive 分支走 .nt-doc。
  // YUK-339：note-types 分支 Notion 化（设计源 NoteReaderBody，
  // screen-note-reader.jsx:46-69）——每块 .nt-blk（28px gutter 网格）+
  // .nt-blk-gutter 手柄（section 折叠 / 非 section 锚点）+ .nt-blk-content；section =
  // semanticBlock 小节（标题 h2.nt-blk-h，折叠隐体留标题）。已如下偏离设计源
  // 并在 PR 记录：锚点 id 沿用既有 nb-<blockId|index> 方案（outline 同源，非设计
  // 的 nb-anchor- 前缀）；锚点按钮做深链（hash + 滚动），不做剪贴板复制；生产无
  // b.link 链接行语义（crossLink 整块即链接卡，YUK-541），不引链接行。
  return (
    <div className="nt-body">
      {blocks.length === 0 && <p className="nt-quiet">空笔记——切到编辑写第一块。</p>}
      {blocks.map((b, i) => {
        const anchorId = `nb-${b.attrs?.id ?? i}`;
        const blockKey = b.attrs?.id ?? String(i);
        const sectionLabel = sectionKindLabel(b);
        const isSection = sectionLabel !== null;
        const isCollapsed = collapsed.has(blockKey);
        return (
          <div
            key={blockKey}
            id={anchorId}
            className={
              isSection
                ? 'nt-blk nt-blk-section'
                : `nt-blk ${BLOCK_KIND_CLASS[b.type] ?? 'nt-blk-plain'}`
            }
          >
            <div className="nt-blk-gutter">
              {isSection ? (
                <button
                  type="button"
                  className="nt-blk-btn nt-blk-collapse"
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed ? `展开「${sectionLabel}」小节` : `折叠「${sectionLabel}」小节`
                  }
                  onClick={() => toggleSection(blockKey)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="nt-blk-btn"
                  title="锚点链接"
                  aria-label="锚点链接：更新地址栏并直达此块"
                  onClick={() => jumpToBlockAnchor(anchorId)}
                >
                  <Link size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="nt-blk-content">
              {isSection && <h2 className="nt-blk-h">{sectionLabel}</h2>}
              {(!isSection || !isCollapsed) && (
                <NoteBlockView
                  block={b}
                  variant="read"
                  onLink={(artifactId) => navigate(`/notes/${artifactId}`)}
                  onOpenQuestion={onOpenQuestion}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
