// inc-4b (YUK-403) — 草稿审核面 /drafts。owner manual gate 的真面：把 loom
// docs/design/loom-refresh/project/screen-draft-review.jsx 像素级复刻为真 React，
// 接真后端（GET /api/review/drafts[/:id] + POST .../enable[/force-enable]），替掉
// demo 的内存池。master-detail：左 list（截断预览 + verify 状态）+ 右 preview
// （选中项拉全文 detail）。批量 verify = 客户端顺序队列；跳过 = 本地 session dismiss。
//
// 与 demo 的真数据取舍：
//   • DR_SOURCE 用真 question.source enum（13 值，非 demo 的 web/gen/manual 三值）。
//   • QKIND 用真 QuestionKind enum（choice/fill_blank/... 非 demo 的 mcq/cloze/...）。
//   • options 后端给 string[]（markdown 串，非 demo 的 {key,text}）——按 A/B/C/D
//     行号渲染，正确项无从得知（后端 detail 不含 answer key 对照），故不高亮 correct。
//   • 省略 AI origin/置信度/成本（后端无此投影，且 demo 本就 Tweak-gated）——不渲 DrOrigin。
//   • 难度 pips / 知识点 tags 接真 detail.difficulty / detail.knowledge[].label。
//   • markdown 经 @/ui/lib/math-markdown（notation='latex'，与 ReviewAnswerPreview 一致，
//     草稿池跨科含 LaTeX 数学题）；QInline 用同组件（react-markdown 单段自动 unwrap）。

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './draft-review.css';

import {
  type DraftPromoteResult,
  type DraftReviewDetail,
  type DraftReviewRow,
  type DraftVerifyStatus,
  enableDraft,
  forceEnableDraft,
  getDraftDetail,
  getDrafts,
} from './practice-api';

// ── 映射（内联 const，对照 data-review.jsx / data-questions.jsx，但用真 enum） ──

type Tone = 'neutral' | 'info' | 'coral' | 'good' | 'hard' | 'again';

// question.source（src/core/schema/business.ts QuestionSource，13 值）→ label/tone/icon。
// 设计 DR_SOURCE 只覆盖 web/gen/manual；这里铺满真 enum：AI 生成类→coral/sparkle，
// 采集/导入类→info/download，人工/教学类→neutral/pencil。
const DR_SOURCE: Record<string, { label: string; tone: Tone; icon: LoomIconName }> = {
  quiz_gen: { label: 'AI 生成', tone: 'coral', icon: 'sparkle' },
  dreaming: { label: 'Dreaming', tone: 'coral', icon: 'sparkle' },
  mistake_variant: { label: '错题变体', tone: 'coral', icon: 'sparkle' },
  copilot_authored: { label: 'Copilot 拟题', tone: 'coral', icon: 'sparkle' },
  web_sourced: { label: 'web 采集', tone: 'info', icon: 'download' },
  vision_single: { label: '拍照录入', tone: 'info', icon: 'camera' },
  vision_paper: { label: '拍照整卷', tone: 'info', icon: 'camera' },
  embedded: { label: '内嵌题', tone: 'info', icon: 'layers' },
  teaching_check: { label: '教学检查', tone: 'info', icon: 'teach' },
  daily: { label: '每日检查', tone: 'neutral', icon: 'clock' },
  final: { label: '终测', tone: 'neutral', icon: 'target' },
  reverse_mark: { label: '反向标记', tone: 'neutral', icon: 'reverse' },
  manual: { label: '手动录入', tone: 'neutral', icon: 'pencil' },
};
const DR_SOURCE_FALLBACK = {
  label: '其它来源',
  tone: 'neutral' as Tone,
  icon: 'doc' as LoomIconName,
};
function srcMeta(source: string) {
  return DR_SOURCE[source] ?? DR_SOURCE_FALLBACK;
}

// question.kind（QuestionKind enum + QUESTION_KIND_OPTIONS 标签）→ label/icon。
const QKIND: Record<string, { label: string; icon: LoomIconName }> = {
  choice: { label: '选择', icon: 'list' },
  true_false: { label: '判断', icon: 'check' },
  fill_blank: { label: '填空', icon: 'hash' },
  short_answer: { label: '简答', icon: 'pencil' },
  essay: { label: '论述', icon: 'doc' },
  computation: { label: '计算', icon: 'hash' },
  reading: { label: '阅读', icon: 'book' },
  translation: { label: '翻译', icon: 'book' },
  derivation: { label: '推导', icon: 'fx' },
};
const QKIND_FALLBACK = { label: '题', icon: 'quiz' as LoomIconName };
function kindMeta(kind: string) {
  return QKIND[kind] ?? QKIND_FALLBACK;
}

// difficulty 1-5 → tone + word（data-review.jsx DR_DIFF）。
const DR_DIFF: Record<number, { tone: Tone; word: string }> = {
  1: { tone: 'good', word: '易' },
  2: { tone: 'good', word: '较易' },
  3: { tone: 'hard', word: '中等' },
  4: { tone: 'again', word: '较难' },
  5: { tone: 'again', word: '难' },
};
function diffMeta(d: number) {
  return DR_DIFF[d] ?? { tone: 'neutral' as Tone, word: `难度 ${d}` };
}

// verify 状态（data-review.jsx DR_VERIFY）→ label/tone/icon。
const DR_VERIFY: Record<DraftVerifyStatus, { label: string; tone: Tone; icon: LoomIconName }> = {
  unverified: { label: '未验证', tone: 'neutral', icon: 'clock' },
  needs_review: { label: '待复核', tone: 'hard', icon: 'alert' },
  failed: { label: '验证未过', tone: 'again', icon: 'close' },
};

const VERIFY_DIAG_TITLE: Record<DraftVerifyStatus, string> = {
  unverified: '尚未运行 verify',
  needs_review: 'verify 待复核',
  failed: 'verify 未通过',
};

// ── 小组件 ──────────────────────────────────────────────────────

function DrPips({ d }: { d: number }) {
  const { tone, word } = diffMeta(d);
  return (
    <span className="dr-pips" title={`难度 ${d} · ${word}`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`dr-pip${i <= d ? ` on tone-${tone}` : ''}`} />
      ))}
      <span className="dr-pip-w">{word}</span>
    </span>
  );
}

function DrVChip({ v }: { v: DraftVerifyStatus }) {
  const m = DR_VERIFY[v];
  return (
    <span className={`dr-vchip tone-${m.tone}`}>
      <LoomIcon name={m.icon} size={11} />
      {m.label}
    </span>
  );
}

function DrSrc({ source }: { source: string }) {
  const s = srcMeta(source);
  return (
    <span className={`dr-tag dr-src tone-${s.tone}`}>
      <LoomIcon name={s.icon} size={11} />
      {s.label}
    </span>
  );
}

function DrKind({ kind }: { kind: string }) {
  const k = kindMeta(kind);
  return (
    <span className="dr-tag dr-kind">
      <LoomIcon name={k.icon} size={11} />
      {k.label}
    </span>
  );
}

// 去 markdown/latex 标记符——列表行 stem 与搜索匹配都用纯文本（避免 *`$ 干扰）。
function plainText(s: string): string {
  return (s || '').replace(/[*`$＿_]/g, '');
}

// 创建时间人类标签——后端给 ISO 串，转本地日期+时分。
function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function KnowledgeTags({ tags }: { tags: { id: string; label: string }[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="dr-ktags">
      {tags.map((k) => (
        <span key={k.id} className="dr-ktag">
          <LoomIcon name="tag" size={10} />
          {k.label}
        </span>
      ))}
    </span>
  );
}

// ── preview pane（DrPreview + DrPreviewBody，split 布局） ──────────

function DrPreviewBody({ d }: { d: DraftReviewDetail }) {
  return (
    <>
      {d.passage && (
        <div className="dr-pv-block">
          <div className="dr-pv-h">
            <LoomIcon name="book" size={12} />
            材料 passage
          </div>
          <MathMarkdown notation="latex" className="dr-passage">
            {d.passage}
          </MathMarkdown>
        </div>
      )}

      <div className="dr-pv-block">
        <div className="dr-pv-h">
          <LoomIcon name="quiz" size={12} />
          题面 prompt_md
        </div>
        <MathMarkdown notation="latex" className="dr-stem-doc">
          {d.prompt_md}
        </MathMarkdown>
        {d.options && d.options.length > 0 && (
          <div className="dr-opts">
            {d.options.map((opt, i) => (
              // 后端 detail 投影只给 choices_md 文本串、不给正确项 key（answer 是
              // reference_md 自由文本，无 enum 对照）——故不渲染 .correct 高亮。
              // biome-ignore lint/suspicious/noArrayIndexKey: choices 是定序文本串、无稳定 id，A/B/C/D 行号即语义
              <div key={i} className="dr-opt">
                <span className="dr-opt-key">{String.fromCharCode(65 + i)}</span>
                <span className="dr-opt-txt">
                  <MathMarkdown notation="latex">{opt}</MathMarkdown>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dr-pv-block">
        {d.answer ? (
          <div className="dr-answer">
            <div className="dr-pv-h">
              <LoomIcon name="check" size={12} />
              参考答案 answer
            </div>
            <MathMarkdown notation="latex" className="dr-answer-body">
              {d.answer}
            </MathMarkdown>
          </div>
        ) : (
          <div className="dr-answer-missing">
            <LoomIcon name="alert" size={14} />
            缺少 answer 字段 — judge 无法校对正误
          </div>
        )}
      </div>

      <div className="dr-pv-block">
        <div className="dr-pv-h">
          <LoomIcon name="tag" size={12} />
          知识点 · 难度
        </div>
        <div className="dr-meta-v" style={{ gap: 'var(--s-3)' }}>
          <KnowledgeTags tags={d.knowledge} />
          <DrPips d={d.difficulty} />
        </div>
      </div>
    </>
  );
}

interface PreviewProps {
  activeId: string | null;
  detailQ: ReturnType<typeof useQuery<DraftReviewDetail>>;
  verifyingId: string | null;
  onEnable: (id: string) => void;
  onForce: (d: DraftReviewDetail) => void;
  onSkip: (id: string) => void;
}

function DrPreview({ activeId, detailQ, verifyingId, onEnable, onForce, onSkip }: PreviewProps) {
  if (!activeId) {
    return (
      <div className="dr-preview">
        <div className="dr-pv-empty">
          <EmptyState
            icon="eye"
            title="选一条草稿审阅"
            text="左侧逐条点开，确认题面与 verify 诊断后，决定启用、强制启用或跳过。"
          />
        </div>
      </div>
    );
  }
  if (detailQ.isLoading || !detailQ.data) {
    return (
      <div className="dr-preview">
        <div className="dr-pv-empty">
          {detailQ.isError ? (
            <EmptyState
              icon="alert"
              title="草稿加载失败"
              text={(detailQ.error as Error)?.message ?? '请稍后重试。'}
            />
          ) : (
            <EmptyState icon="clock" title="取草稿…" text="正在拉取草稿全文。" />
          )}
        </div>
      </div>
    );
  }

  const d = detailQ.data;
  const diagTone = DR_VERIFY[d.verify_status].tone;
  const verifying = verifyingId === d.id;

  return (
    <div className="dr-preview">
      <div className="dr-pv-head">
        <div style={{ minWidth: 0 }}>
          <div className="dr-pv-eyebrow">
            DRAFT · <b>{d.id}</b> · status=draft
          </div>
          <div className="dr-pv-tags">
            <DrKind kind={d.kind} />
            <DrSrc source={d.source} />
            <DrVChip v={d.verify_status} />
          </div>
        </div>
      </div>

      <div className={`dr-diag tone-${diagTone}`}>
        <span className="dr-diag-ic">
          <LoomIcon name={DR_VERIFY[d.verify_status].icon} size={16} />
        </span>
        <div className="dr-diag-body">
          <div className="dr-diag-title">{VERIFY_DIAG_TITLE[d.verify_status]}</div>
          {d.verify_reason ? (
            <div className="dr-diag-reason">
              <span className="lab">驳回理由 · </span>
              {d.verify_reason}
            </div>
          ) : (
            <div className="dr-diag-reason">
              这条草稿还没过 verify。点「启用」会跑一遍判题（可能耗时），通过即转 active。
            </div>
          )}
        </div>
      </div>

      <div className="dr-pv-body">
        <DrPreviewBody d={d} />
      </div>

      <div className="dr-actions">
        {verifying ? (
          <span className="dr-pv-verifying">
            <span className="dr-spin" />
            verify 运行中 · B5 判题 agent…
          </span>
        ) : (
          <>
            <Btn variant="primary" icon="check" onClick={() => onEnable(d.id)}>
              启用
            </Btn>
            <button type="button" className="btn btn-secondary btn-warn" onClick={() => onForce(d)}>
              <LoomIcon name="bolt" size={17} />
              强制启用
            </button>
            <span className="dr-act-spacer" />
            <Btn variant="ghost" icon="close" onClick={() => onSkip(d.id)}>
              跳过
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

// ── 强制启用确认 modal ──────────────────────────────────────────
const FORCE_REASONS = [
  '题面我已人工核对，质量无误',
  '考点紧缺，先上线再补验',
  'verify 规则误报，非真实缺陷',
  '来源可信，本批免验',
];

function DrForceModal({
  d,
  pending,
  onClose,
  onConfirm,
}: {
  d: DraftReviewDetail;
  pending: boolean;
  onClose: () => void;
  onConfirm: (id: string, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 4;

  // Esc 关闭 + mount 时聚焦输入框（轻量 focus 管理，无第三方 trap）。
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="dr-modal-wrap">
      <button
        type="button"
        aria-label="关闭"
        className="scrim open"
        style={{ zIndex: 0, border: 0, padding: 0 }}
        onClick={onClose}
      />
      <div
        className="dr-modal"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> 需 imperative
        // showModal()/close() API，与 CSS-class 驱动的 portal + scrim 模式不兼容（同
        // CopilotDrawer / CommandPalette / PfSolo）。
        role="dialog"
        aria-modal="true"
        aria-label="强制启用确认"
      >
        <div className="dr-modal-head">
          <span className="dr-modal-ic">
            <LoomIcon name="bolt" size={18} />
          </span>
          <span className="dr-modal-title">强制启用 · 绕过验证</span>
        </div>
        <div className="dr-modal-body">
          <div className="dr-bypass">
            <span className="dr-bypass-ic">
              <LoomIcon name="alert" size={18} />
            </span>
            <span className="dr-bypass-text">
              <b>这条草稿将跳过 verify 直接转为 active。</b>
              系统不会再校对题面与答案的正误。此操作记入 event log（
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                actor=user · action=force_enable
              </span>
              ），必须填写理由留痕。
            </span>
          </div>
          <div className="dr-modal-q">
            <MathMarkdown notation="latex">{d.prompt_md}</MathMarkdown>
          </div>
          <label className="dr-field-label" htmlFor="dr-reason">
            绕过验证的理由 <span className="req">*</span> 必填
          </label>
          <textarea
            id="dr-reason"
            ref={inputRef}
            className="dr-reason-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="说明为什么这条草稿可以不经 verify 直接启用…"
          />
          <div className="dr-reason-chips">
            {FORCE_REASONS.map((r) => (
              <button key={r} type="button" className="dr-reason-chip" onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <div className="dr-reason-hint">
            <LoomIcon name="alert" size={12} />
            理由至少 4 个字，会与本次 override 一并存档。
          </div>
        </div>
        <div className="dr-modal-foot">
          <Btn variant="ghost" onClick={onClose}>
            取消
          </Btn>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!ok || pending}
            onClick={() => onConfirm(d.id, reason.trim())}
          >
            <LoomIcon name="bolt" size={16} />
            {pending ? '强制启用中…' : '确认强制启用'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── toasts ──────────────────────────────────────────────────────
interface Toast {
  id: string;
  kind: 'good' | 'warn' | null;
  text: string;
}

function DrToasts({ items }: { items: Toast[] }) {
  if (items.length === 0) return null;
  return createPortal(
    <div className="dr-toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={`dr-toast ${t.kind ?? ''}`}>
          <LoomIcon
            name={t.kind === 'good' ? 'checkCircle' : t.kind === 'warn' ? 'alert' : 'bolt'}
            size={15}
          />
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ── 主面 ────────────────────────────────────────────────────────
const DR_PAGE_SIZE = 8;

type VStatusTab = 'all' | DraftVerifyStatus;

export interface DraftReviewPageProps {
  navigate: (to: string) => void;
}

export default function DraftReviewPage({ navigate }: DraftReviewPageProps) {
  const qc = useQueryClient();

  // list query：取全量 draft 池（默认 limit=50；后端封顶 200）。source/kind
  // 经 query 透传给后端；搜索/verify-tab 在前端过滤（设计 demo 同：搜索是前端）。
  const draftsQ = useQuery({ queryKey: ['drafts'], queryFn: () => getDrafts({ limit: 200 }) });

  const [query, setQuery] = useState('');
  const [vstatus, setVstatus] = useState<VStatusTab>('all');
  const [page, setPage] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  // 客户端顺序队列里正在 verify 的那条（一次一条，照 demo runBatch 语义）。
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  // session-only dismiss：inc-4a 无 skip 端点——「跳过」仅本地移出当前视图，
  // 不持久（刷新后草稿仍在池）。强制启用成功后也用它把已转 active 的行移出。
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [forceDraft, setForceDraft] = useState<DraftReviewDetail | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((kind: 'good' | 'warn' | null, text: string) => {
    const id = `t${Date.now()}${Math.random()}`;
    setToasts((ts) => [...ts, { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2600);
  }, []);

  const rows = useMemo(() => draftsQ.data?.rows ?? [], [draftsQ.data]);

  // 来源 / 题型 select 选项——从当前池实际出现的值动态生成（不堆全 enum 死值）。
  const sourceOptions = useMemo(() => [...new Set(rows.map((r) => r.source))].sort(), [rows]);
  const kindOptions = useMemo(() => [...new Set(rows.map((r) => r.kind))].sort(), [rows]);
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');

  // visible = 池 - 本地 dismiss。
  const visible = useMemo(() => rows.filter((r) => !dismissed.has(r.id)), [rows, dismissed]);

  const matchQuery = useCallback(
    (r: DraftReviewRow) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const hay = `${plainText(r.prompt_preview)} ${r.id} ${r.knowledge
        .map((k) => k.label)
        .join(' ')}`;
      return hay.toLowerCase().includes(q);
    },
    [query],
  );

  const filtered = useMemo(
    () =>
      visible.filter(
        (r) =>
          (source === 'all' || r.source === source) &&
          (kind === 'all' || r.kind === kind) &&
          (vstatus === 'all' || r.verify_status === vstatus) &&
          matchQuery(r),
      ),
    [visible, source, kind, vstatus, matchQuery],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / DR_PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(curPage * DR_PAGE_SIZE, curPage * DR_PAGE_SIZE + DR_PAGE_SIZE);

  // keep an active selection valid（设计稿：filtered 变动时选中首条）。filtered 是
  // useMemo，输入不变时引用稳定，可直接入依赖。
  useEffect(() => {
    if (filtered.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!filtered.some((r) => r.id === activeId)) setActiveId(filtered[0].id);
  }, [filtered, activeId]);

  // detail query：选中项拉全文（enabled on activeId）。
  const detailQ = useQuery({
    queryKey: ['draft-detail', activeId],
    queryFn: () => getDraftDetail(activeId as string),
    enabled: activeId !== null,
  });

  const activeFilters =
    (source !== 'all' ? 1 : 0) +
    (kind !== 'all' ? 1 : 0) +
    (vstatus !== 'all' ? 1 : 0) +
    (query.trim() ? 1 : 0);
  const reset = () => {
    setSource('all');
    setKind('all');
    setVstatus('all');
    setQuery('');
    setPage(0);
  };

  // mutations。enable / force-enable 成功后：promoted 转 active → 本地 dismiss
  // 移出池 + invalidate；未 promote → invalidate 让 list 拉新 verify 状态 + 留池。
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['drafts'] });
    if (activeId) void qc.invalidateQueries({ queryKey: ['draft-detail', activeId] });
  }, [qc, activeId]);

  const applyPromote = useCallback(
    (id: string, res: DraftPromoteResult) => {
      if (res.promoted) {
        setDismissed((s) => new Set(s).add(id));
        setPicked((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        });
        pushToast('good', `「${id}」通过验证 · 已转 active`);
      } else {
        pushToast('warn', `「${id}」验证未过`);
      }
    },
    [pushToast],
  );

  const enableMut = useMutation({
    mutationFn: (id: string) => enableDraft(id),
    onMutate: (id: string) => setVerifyingId(id),
    onSuccess: (res, id) => applyPromote(id, res),
    onError: (err: Error, id) => pushToast('warn', `「${id}」启用失败：${err.message}`),
    onSettled: () => {
      setVerifyingId(null);
      refresh();
    },
  });

  const forceMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => forceEnableDraft(id, reason),
    onSuccess: (res, { id }) => {
      setForceDraft(null);
      if (res.promoted) {
        setDismissed((s) => new Set(s).add(id));
        setPicked((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        });
        pushToast('warn', `「${id}」已强制启用 · override 已留痕`);
      } else {
        // force-enable 理论上 promoted=true；若被 B-section guard 拒，回 reason。
        pushToast('warn', `「${id}」强制启用被拒：${res.reason ?? res.status}`);
      }
    },
    onError: (err: Error, { id }) => pushToast('warn', `「${id}」强制启用失败：${err.message}`),
    onSettled: () => refresh(),
  });

  const enableOne = useCallback((id: string) => enableMut.mutate(id), [enableMut]);

  // 批量 verify = 客户端顺序队列：逐条 await enableDraft（照 demo runBatch；
  // 不并发——避免一把打满 verify agent / 付费 lane）。
  const runBatch = useCallback(async () => {
    const ids = filtered.filter((r) => picked.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    for (const id of ids) {
      setVerifyingId(id);
      try {
        const res = await enableDraft(id);
        applyPromote(id, res);
      } catch (err) {
        pushToast('warn', `「${id}」启用失败：${(err as Error).message}`);
      }
    }
    setVerifyingId(null);
    refresh();
  }, [filtered, picked, applyPromote, pushToast, refresh]);

  // 跳过 = 本地 session dismiss（inc-4a 无 skip 端点——仅本地移出，不持久）。
  const skipOne = useCallback(
    (id: string) => {
      setDismissed((s) => new Set(s).add(id));
      setPicked((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
      pushToast(null, `「${id}」已跳过 · 移出待审池`);
    },
    [pushToast],
  );

  const confirmForce = useCallback(
    (id: string, reason: string) => forceMut.mutate({ id, reason }),
    [forceMut],
  );

  const togglePick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pickedHere = filtered.filter((r) => picked.has(r.id)).length;
  const allPicked = filtered.length > 0 && pickedHere === filtered.length;
  const toggleAll = () =>
    setPicked((p) => {
      const n = new Set(p);
      if (allPicked) for (const r of filtered) n.delete(r.id);
      else for (const r of filtered) n.add(r.id);
      return n;
    });

  // KPI（对 visible 全池，非 filtered）。
  const nUnver = visible.filter((r) => r.verify_status === 'unverified').length;
  const nReview = visible.filter((r) => r.verify_status === 'needs_review').length;
  const nFailed = visible.filter((r) => r.verify_status === 'failed').length;

  const V_TABS: Array<[VStatusTab, string, number]> = [
    ['all', '全部', visible.length],
    ['unverified', '未验证', nUnver],
    ['needs_review', '待复核', nReview],
    ['failed', '验证未过', nFailed],
  ];

  const batchRunning = verifyingId !== null;

  return (
    <div className="page dr-page view" data-dr-layout="split">
      <div className="page-head">
        <div className="eyebrow">
          REVIEW · draft 池 · events action=propose subject_kind=question status=draft
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">草稿审核</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="quiz" onClick={() => navigate('/practice')}>
              练习
            </Btn>
            <Btn variant="ghost" icon="record" onClick={() => navigate('/record')}>
              录入新题
            </Btn>
          </div>
        </div>
      </div>

      {draftsQ.isLoading ? (
        <Card pad="default">
          <p className="quiet-empty">取草稿池…</p>
        </Card>
      ) : draftsQ.isError ? (
        <Card pad="lg">
          <EmptyState
            icon="alert"
            title="草稿池加载失败"
            text={(draftsQ.error as Error)?.message ?? '请稍后重试。'}
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card pad="lg">
          <EmptyState
            icon="checkCircle"
            title="待审草稿池是空的，太好了"
            text="没有等待审核的草稿。AI 夜间生成、web 采集或你手动录入的新题会先落到这里，等你逐条放行。"
            action={
              <Btn variant="secondary" icon="record" onClick={() => navigate('/record')}>
                去录入
              </Btn>
            }
          />
        </Card>
      ) : (
        <>
          {/* summary ribbon */}
          <div className="dr-ribbon">
            <div className="dr-stat">
              <span className="dr-stat-n tnum">
                {visible.length}
                <span className="u">条待审</span>
              </span>
              <span className="dr-stat-l">draft pool</span>
            </div>
            <div className="dr-stat">
              <span className="dr-stat-n tnum">{nUnver}</span>
              <span className="dr-stat-l">未验证</span>
            </div>
            <div className="dr-stat warn">
              <span className="dr-stat-n tnum">{nReview + nFailed}</span>
              <span className="dr-stat-l">待复核 / 未过</span>
            </div>
            <div className="dr-ribbon-spacer" />
          </div>

          {/* toolbar：搜索 + 来源/题型 select */}
          <div className="dr-toolbar">
            <label className="dr-search">
              <LoomIcon name="search" size={15} />
              <input
                placeholder="搜索题面文本、知识点、草稿号…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
              {query && (
                <button
                  type="button"
                  className="dr-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="清除"
                >
                  <LoomIcon name="close" size={13} />
                </button>
              )}
            </label>
            <div className="dr-fgroup">
              <span className="dr-fgroup-l">来源</span>
              <select
                className="dr-select"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">全部来源</option>
                {sourceOptions.map((s) => (
                  <option key={s} value={s}>
                    {srcMeta(s).label}
                  </option>
                ))}
              </select>
            </div>
            <div className="dr-fgroup">
              <span className="dr-fgroup-l">题型</span>
              <select
                className="dr-select"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">全部题型</option>
                {kindOptions.map((k) => (
                  <option key={k} value={k}>
                    {kindMeta(k).label}
                  </option>
                ))}
              </select>
            </div>
            {activeFilters > 0 && (
              <button type="button" className="dr-reset" onClick={reset}>
                <LoomIcon name="close" size={12} />
                清除 {activeFilters} 项
              </button>
            )}
          </div>

          {/* verify-status segmented tabs */}
          <div className="dr-toolbar" style={{ marginBottom: 'var(--s-3)' }}>
            <div className="dr-seg" role="tablist">
              {V_TABS.map(([k, l, n]) => (
                <button
                  type="button"
                  key={k}
                  role="tab"
                  aria-selected={vstatus === k}
                  className={vstatus === k ? 'on' : ''}
                  onClick={() => {
                    setVstatus(k);
                    setPage(0);
                  }}
                >
                  {k !== 'all' && <span className={`dr-vdot tone-${DR_VERIFY[k].tone}`} />}
                  {l}
                  <span className="seg-n">{n}</span>
                </button>
              ))}
            </div>
          </div>

          {/* batch bar */}
          <div className={`dr-batchbar${pickedHere > 0 ? ' is-armed' : ''}`}>
            <input
              type="checkbox"
              className={`dr-check${!allPicked && pickedHere > 0 ? ' is-indet' : ''}`}
              checked={allPicked}
              onChange={toggleAll}
              aria-label="全选"
            />
            {pickedHere > 0 ? (
              <>
                <span className="dr-batch-label">
                  已选 <b>{pickedHere}</b> 条
                </span>
                <Btn
                  size="sm"
                  variant="primary"
                  icon="check"
                  disabled={batchRunning}
                  onClick={() => void runBatch()}
                >
                  verify 选中（队列逐条跑）
                </Btn>
                <Btn size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                  取消选择
                </Btn>
                <span className="dr-batch-spacer" />
                <span className="dr-batch-hint">
                  通过的转 active 并移出池，未过的留下显示驳回理由
                </span>
              </>
            ) : (
              <>
                <span className="dr-batch-label">勾选多条可批量送 verify</span>
                <span className="dr-batch-spacer" />
                <span className="dr-batch-hint">{filtered.length} 条符合当前筛选</span>
              </>
            )}
          </div>

          <div className="dr-body">
            {/* list */}
            <div className="dr-list">
              {pageRows.length === 0 ? (
                <div style={{ padding: 'var(--s-8) var(--s-5)' }}>
                  <EmptyState
                    icon="search"
                    title="没有匹配的草稿"
                    text="放宽筛选或清除搜索。"
                    action={
                      <Btn size="sm" variant="secondary" icon="close" onClick={reset}>
                        清除筛选
                      </Btn>
                    }
                  />
                </div>
              ) : (
                pageRows.map((r) => {
                  const verifying = verifyingId === r.id;
                  return (
                    // 行用 div + role=button（非 <button>）：行内嵌套真复选框，button>input
                    // 是非法嵌套（同 PfStream 行卡片先例）。Enter/Space 选中行。
                    <div
                      key={r.id}
                      className={`dr-row${activeId === r.id ? ' is-active' : ''}${
                        verifying ? ' is-pending' : ''
                      }`}
                      // biome-ignore lint/a11y/useSemanticElements: 行卡片内嵌套了真复选框，<button> 不可含 interactive 子元素；div+role 是正确 ARIA 形态
                      role="button"
                      tabIndex={0}
                      onClick={() => setActiveId(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveId(r.id);
                        }
                      }}
                    >
                      {/* 勾选框：用 label 包裹并 stop click/key 冒泡，避免点选触发行选中 */}
                      <label
                        className="dr-row-pick"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="dr-check"
                          checked={picked.has(r.id)}
                          onChange={() => togglePick(r.id)}
                          aria-label={`选择 ${r.id}`}
                        />
                      </label>
                      <span className="dr-row-main">
                        <span className="dr-row-stem">{plainText(r.prompt_preview)}</span>
                        <span className="dr-row-meta">
                          <DrKind kind={r.kind} />
                          <DrSrc source={r.source} />
                          {verifying ? (
                            <span className="dr-rowq pending">
                              <span className="dr-spin" />
                              verify 中…
                            </span>
                          ) : (
                            <DrVChip v={r.verify_status} />
                          )}
                          <span className="dr-time">{whenLabel(r.created_at)}</span>
                        </span>
                      </span>
                    </div>
                  );
                })
              )}

              {/* pager */}
              {pageCount > 1 && (
                <div className="dr-pager">
                  <span className="dr-pager-info">
                    第 {curPage * DR_PAGE_SIZE + 1}–
                    {Math.min((curPage + 1) * DR_PAGE_SIZE, filtered.length)} / {filtered.length}
                  </span>
                  <div className="dr-pager-ctrl">
                    <button
                      type="button"
                      className="dr-pg"
                      disabled={curPage === 0}
                      onClick={() => setPage(curPage - 1)}
                      aria-label="上一页"
                    >
                      <LoomIcon name="arrowL" size={13} />
                    </button>
                    {Array.from({ length: pageCount }).map((_, i) => (
                      <button
                        type="button"
                        // biome-ignore lint/suspicious/noArrayIndexKey: 页码即序号，稳定
                        key={i}
                        className={`dr-pg${i === curPage ? ' on' : ''}`}
                        onClick={() => setPage(i)}
                      >
                        {i + 1}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="dr-pg"
                      disabled={curPage === pageCount - 1}
                      onClick={() => setPage(curPage + 1)}
                      aria-label="下一页"
                    >
                      <LoomIcon name="arrow" size={13} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* preview */}
            <DrPreview
              activeId={activeId}
              detailQ={detailQ}
              verifyingId={verifyingId}
              onEnable={enableOne}
              onForce={(d) => setForceDraft(d)}
              onSkip={skipOne}
            />
          </div>
        </>
      )}

      {forceDraft && (
        <DrForceModal
          d={forceDraft}
          pending={forceMut.isPending}
          onClose={() => setForceDraft(null)}
          onConfirm={confirmForce}
        />
      )}
      <DrToasts items={toasts} />
    </div>
  );
}
