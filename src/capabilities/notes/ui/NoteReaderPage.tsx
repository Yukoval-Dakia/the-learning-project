// M3 笔记面 — 阅读器宿主（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-note-reader.jsx：三栏
//（大纲 rail / 正文 / Context 右栏四区：属性 · labels 命中 · 相关学习项 ·
// 活动版本）+ topbar（返回入口感知 + /notes/{id} pill + 阅读/编辑 seg）。
// 编辑保存 = PATCH body-blocks 乐观锁（409 → 提示刷新，pre-flight B 偏离②）；
// AI refine 痕迹与 undo 接 ai-changes 链（T5 已验真）。

import { ApiError } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import './note-reader.css';

import { NoteBlockView, blockOutlineLabel } from './NoteBlocks';
import { NoteEditor } from './NoteEditor';
import {
  type BodyBlock,
  editingBlur,
  editingHeartbeat,
  getAiChanges,
  getNotePage,
  saveBodyBlocks,
  undoAiChange,
} from './notes-api';

export default function NoteReaderPage({
  id,
  navigate,
}: {
  id: string;
  navigate: (to: string) => void;
}) {
  const qc = useQueryClient();
  const noteQ = useQuery({ queryKey: ['note-page', id], queryFn: () => getNotePage(id) });
  const changesQ = useQuery({ queryKey: ['note-ai-changes', id], queryFn: () => getAiChanges(id) });

  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [draft, setDraft] = useState<BodyBlock[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // S12 (YUK-335)：入口上下文——同一篇笔记从多个 knowledge 节点可达（设计「一篇
  // 笔记多扇门」）。read 态从 ?entry=<knowledge_id> 读当前入口，mount 读一次即可
  // （非 reactive 订阅，同 RecordRoute 的 getQuery mount-only 读法 router.tsx:99）。
  // 无 param → 无入口上下文（banner 不渲、strip 不高亮、返回链回退 labels[0]）。
  const [entryKid] = useState(() => new URLSearchParams(window.location.search).get('entry'));

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
  }

  // 编辑期 presence（M5 全分支 review H2 接线）：编辑态每 5s 心跳，worker 的
  // note-refine 据此 defer AI patch（ADR-0023 不变量）；离开编辑态（切回阅读 /
  // 保存成功 / 换笔记 / 卸载）blur——服务端置 idle 并 FIFO flush 被 defer 的
  // patch。best-effort：presence 失败不打断编辑（与旧 ArtifactBlockTree 等价），
  // 兜底是 30s 心跳超时 sticky idle + PATCH 乐观锁。
  useEffect(() => {
    if (mode !== 'edit') return;
    const sendHeartbeat = () => {
      void editingHeartbeat(id).catch(() => {});
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 5000);
    return () => {
      window.clearInterval(timer);
      void editingBlur(id).catch(() => {});
    };
  }, [mode, id]);

  const say = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  };

  const saveM = useMutation({
    mutationFn: () =>
      saveBodyBlocks(id, {
        artifact_version: note?.version ?? 0,
        body_blocks: { type: 'doc', content: draft ?? [] },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['note-page', id] });
      void qc.invalidateQueries({ queryKey: ['note-ai-changes', id] });
      setMode('read');
      setDraft(null);
      say('已保存——版本推进，refine 痕迹照常累积。');
    },
    onError: (e) => {
      const msg = (e as Error).message;
      say(
        msg.includes('409') || msg.includes('conflict')
          ? '版本冲突：这篇笔记在别处被改过（可能是 AI refine）——刷新后再编辑。'
          : `保存失败：${msg}`,
      );
    },
  });

  const undoM = useMutation({
    mutationFn: (eventId: string) => undoAiChange(id, eventId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['note-page', id] });
      void qc.invalidateQueries({ queryKey: ['note-ai-changes', id] });
      say('已还原该次 AI 修订。');
    },
  });

  // S4 (YUK-335)：空/载态从裸 .quiet-empty 一行字升级为 SkLines/EmptyState
  // primitives——原样式读作「故障」（14px 灰字悬空，无图形锚点/标题层级）。
  if (noteQ.isLoading)
    return (
      <main className="page wide note-reader-page">
        <SkLines rows={6} />
      </main>
    );
  // S4-fix (YUK-335)：error 态独立分支（设计源用 Stateful 三态）——否则瞬时 fetch
  // 失败会落进下面的 !note 分支，被误读成永久「笔记不存在」、且无重试入口。消化
  // ported-but-idle 的 ErrorState（audit P4）。但 404（笔记不存在/已删）语义上
  // 是「空」非「加载失败」——让它落到下面的 EmptyState，只有瞬时错误（网络/5xx）
  // 才示 ErrorState + 重试（视觉环实测：404 误显「加载失败」会反向坏了 not-found 态）。
  const isNotFound = noteQ.error instanceof ApiError && noteQ.error.status === 404;
  if (noteQ.isError && !isNotFound)
    return (
      <main className="page wide note-reader-page">
        <ErrorState text="笔记加载失败。" onRetry={() => void noteQ.refetch()} />
      </main>
    );
  if (!note)
    return (
      <main className="page wide note-reader-page">
        <EmptyState
          icon="doc"
          title="笔记不存在"
          text="这篇笔记不存在或已被归档。"
          action={
            <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => navigate('/knowledge')}>
              返回知识
            </Btn>
          }
        />
      </main>
    );

  // S12 (YUK-335)：entryMatch = ?entry 严格命中的 label（有入口上下文时才 truthy，
  // 用于 banner 文案 + strip .is-here coral 反白）；entryLabel = 返回链/右栏入口
  // tag 的派生来源，命中则用命中 label，否则回退 labels[0]（无入口上下文也保返回链
  // 不空——返回链是导航兜底，不是入口断言）。
  const entryMatch = entryKid ? (note.labels.find((l) => l.id === entryKid) ?? null) : null;
  const entryLabel = entryMatch ?? note.labels[0] ?? null;
  const verified = note.verification_status === 'verified';
  const shown = mode === 'edit' ? (draft ?? []) : blocks;

  return (
    <main className="page wide note-reader-page">
      <div className="note-topbar">
        <button
          type="button"
          className="back-link"
          style={{ margin: 0 }}
          onClick={() => navigate(entryLabel ? `/knowledge/${entryLabel.id}` : '/knowledge')}
        >
          <LoomIcon name="arrowL" size={14} />
          {entryLabel ? '返回知识点' : '知识'}
        </button>
        <span className="meta mono note-id-pill">/notes/{note.id}</span>
        <span className="topbar-spacer" />
        <IconBtn
          icon="panelLeft"
          size={16}
          title="大纲"
          onClick={() => setOutlineOpen((o) => !o)}
        />
        <div className="seg seg-sm note-mode" role="tablist" aria-label="阅读模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'read'}
            className={mode === 'read' ? 'on' : ''}
            onClick={() => {
              // 切回阅读丢弃未保存改动（与保存成功路径一致）。
              setMode('read');
              setDraft(null);
            }}
          >
            <LoomIcon name="eye" size={14} />
            阅读
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={mode === 'edit' ? 'on' : ''}
            onClick={() => {
              // 进入编辑态时一次性快照服务端块；已在编辑中则保持现有草稿。
              setDraft((d) => d ?? note.body_blocks?.content ?? []);
              setMode('edit');
            }}
          >
            <LoomIcon name="pencil" size={14} />
            编辑
          </button>
        </div>
        {mode === 'edit' && (
          <Btn
            size="sm"
            variant="primary"
            icon="check"
            disabled={saveM.isPending}
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? '保存中…' : '保存'}
          </Btn>
        )}
      </div>

      <div className={`note-reader-grid${outlineOpen ? '' : ' no-outline'}`}>
        {outlineOpen && (
          <nav className="note-outline">
            <div className="note-rail-h">
              <LoomIcon name="panelLeft" size={14} />
              大纲 · block tree
            </div>
            {shown.map((b, i) => (
              <button
                type="button"
                key={b.attrs?.id ?? i}
                className="nol-item"
                onClick={() => {
                  document
                    .getElementById(`nb-${b.attrs?.id ?? i}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              >
                <span className="nol-glyph mono">
                  {b.type === 'crossLinkBlock' ? '@' : b.type === 'questionRefBlock' ? '?' : '·'}
                </span>
                <span className="nol-label">{blockOutlineLabel(b)}</span>
              </button>
            ))}
          </nav>
        )}

        <article className="note-doc-col">
          {/* S12 (YUK-335)：入口 banner（设计 screen-note-reader.jsx:201，.note-entry-banner
              coral，CSS 已移植 globals:6819）——仅当 ?entry 命中某 label 时渲，无入口
              上下文不占版面。文案点明「从哪扇门进来」+ 同篇笔记另有几个入口。 */}
          {entryMatch && (
            <div className="note-entry-banner">
              <LoomIcon name="link" size={15} />
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
          <h1 className="page-title serif" style={{ marginBottom: 'var(--s-2)' }}>
            {note.title}
          </h1>
          <div className="nowrap-meta" style={{ marginBottom: 'var(--s-5)' }}>
            <span className="note-kind-tag note-kind-atomic">{note.type}</span>
            <span className={`verify-badge ${verified ? 'verified' : 'draft'}`}>
              <LoomIcon name={verified ? 'check' : 'sparkle'} size={11} />
              {verified ? '已校验' : '草稿'}
            </span>
            <span className="meta mono">v{note.version}</span>
          </div>

          {/* S12 (YUK-335)：入口 strip（设计 :221，.note-entries-strip + .entry-pill，
              CSS 已移植 globals:6855）——「同一篇笔记多扇门」的主表达。遍历 note.labels
              每个 knowledge 标签出一个 pill（点击 navigate 到该知识点）；?entry 命中的
              当前入口加 .is-here（coral 反白）。仅 read 态渲（编辑态不占版面）。 */}
          {mode === 'read' && note.labels.length > 0 && (
            <div className="note-entries-strip">
              <span className="meta">入口 · {note.labels.length}</span>
              {note.labels.map((l) => (
                <button
                  type="button"
                  key={l.id}
                  className={`entry-pill${entryMatch?.id === l.id ? ' is-here' : ''}`}
                  onClick={() => navigate(`/knowledge/${l.id}`)}
                >
                  <LoomIcon name="link" size={12} />
                  {l.name}
                </button>
              ))}
            </div>
          )}

          {mode === 'edit' && draft ? (
            <NoteEditor blocks={draft} labels={note.labels} noteId={note.id} onChange={setDraft} />
          ) : (
            // S12 (YUK-335)：read 态正文套 .note-reader-body（设计 note-reader.css:60，
            // CSS 已移植 globals:6894）→ prose 尺度 fs-body-lg 17px（旧 .note-doc 无字号
            // 定义，块文本落 body 基础 15px）。NoteBlockView 渲染逻辑/outline/编辑态全不动；
            // 仅换包裹类 + read 态 variant（crossLink 渲整宽 BlockLinkCard）。
            // 注：设计的 .nrb-gutter 悬停手柄（折叠/锚点）会触及 block 渲染结构，按规约
            // 降级为 follow-up（先保正文 prose 尺度这个 HIGH）。
            <div className="note-reader-body">
              {blocks.length === 0 && <p className="quiet-empty">空笔记——切到编辑写第一块。</p>}
              {blocks.map((b, i) => (
                <div key={b.attrs?.id ?? i} id={`nb-${b.attrs?.id ?? i}`}>
                  <NoteBlockView
                    block={b}
                    variant="read"
                    onLink={(artifactId) => navigate(`/notes/${artifactId}`)}
                    onOpenQuestion={() => say('题库面随 M5 收口——引用块先提供题面预览。')}
                  />
                </div>
              ))}
            </div>
          )}
        </article>

        <aside className="note-context">
          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="doc" size={13} />
              属性
            </div>
            <div className="note-prop-row">
              <span className="meta">状态</span>
              <span className={`verify-badge ${verified ? 'verified' : 'draft'}`}>
                <LoomIcon name={verified ? 'check' : 'sparkle'} size={11} />
                {verified ? '已校验' : '草稿'}
              </span>
            </div>
            <div className="note-prop-row">
              <span className="meta">版本</span>
              <span className="mono tnum">v{note.version}</span>
            </div>
            <div className="note-prop-row">
              <span className="meta">块数</span>
              <span className="mono tnum">{blocks.length}</span>
            </div>
          </div>

          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="link" size={13} />
              被这些 knowledge 标签命中 · {note.labels.length}
            </div>
            <div className="note-label-list">
              {note.labels.map((l) => (
                <button
                  type="button"
                  key={l.id}
                  className={`note-label-row${entryMatch?.id === l.id ? ' is-entry' : ''}`}
                  onClick={() => navigate(`/knowledge/${l.id}`)}
                >
                  <span className="chip chip-k mono">{l.id.slice(0, 10)}</span>
                  <span className="wenyan">{l.name}</span>
                  {/* S12 (YUK-335)：右栏「入口」tag 只在真有入口上下文（?entry 命中）
                      时显示——与顶部 strip 的 .is-here 同源 entryMatch，无 param 不误标。 */}
                  {entryMatch?.id === l.id && <span className="entry-tag mono">入口</span>}
                  <LoomIcon name="arrow" size={13} className="thread-arrow" />
                </button>
              ))}
            </div>
          </div>

          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="items" size={13} />
              相关学习项 · {note.related_learning_items.length}
            </div>
            {note.related_learning_items.length === 0 ? (
              <div className="meta">暂无共享标签的学习项</div>
            ) : (
              <div className="note-label-list">
                {note.related_learning_items.map((it) => (
                  <button
                    type="button"
                    key={it.id}
                    className="note-label-row"
                    onClick={() => say('学习项 surface 还在旧栈——M4/M5 收口后可跳转。')}
                  >
                    <LoomIcon name="items" size={13} />
                    <span className="wenyan">{it.title}</span>
                    <span className="meta mono">{it.relation}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="history" size={13} />
              活动 · AI 修订
            </div>
            <div className="note-versions">
              {(changesQ.data?.rows ?? []).map((c) => (
                <div key={c.event_id} className={`note-ver${c.undone ? '' : ' is-current'}`}>
                  <span className="note-ver-dot" />
                  <div className="note-ver-body">
                    <div className="note-ver-top">
                      <span className="mono note-ver-v">
                        v{c.previous_artifact_version}→v{c.next_artifact_version}
                      </span>
                      <span className="adm-actor mono">
                        <LoomIcon name="sparkle" size={11} />
                        {c.actor_ref}
                      </span>
                      <span className="meta" style={{ marginLeft: 'auto' }}>
                        {new Date(c.created_at).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="note-ver-note meta">
                      {c.ops_count} ops · {c.new_blocks} 新块
                      {c.undone ? (
                        <span className="badge tone-neutral" style={{ marginLeft: 8 }}>
                          已还原
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="xlink mono"
                          style={{ marginLeft: 8 }}
                          disabled={undoM.isPending}
                          onClick={() => undoM.mutate(c.event_id)}
                        >
                          <LoomIcon name="undo" size={10} />
                          还原
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {(changesQ.data?.rows ?? []).length === 0 && (
                <div className="meta">暂无 AI 修订记录</div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {toast && (
        <div className="pf-toasts" aria-live="polite">
          <div className="pf-toast t-info">
            <LoomIcon name="sparkle" size={15} className="ico" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}
