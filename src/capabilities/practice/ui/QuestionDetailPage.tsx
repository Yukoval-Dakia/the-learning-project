// YUK-413 — 题详情面 /questions/:id。把 loom docs/design/loom-refresh/project/
// screen-question-detail.jsx 像素级复刻为真 React，**替掉** YUK-409 的
// QuestionDetailStubPage。接真后端 GET（富聚合）/ PATCH（编辑面）/ DELETE（约束删除）。
//
// ── 设计↔真数据取舍（demo data-questions.jsx 内存模型 → 真后端投影）─────────────
//   • stem ←→ prompt_md；options ←→ choices_md（string[]，A/B/C/D 按 index；后端
//     choices_md 不存「哪个正确」标记，正确答案落在 reference_md）。故 mcq「点字母设
//     正确答案」= 编辑 reference_md（写入字母）；DEFER 标注。
//   • answer/reference ←→ reference_md（参考答案全文）。demo 的 answerNote 后端无对应
//     列 → 不渲（不 fabricate）。
//   • passage（composite 阅读材料）：后端 question 无 passage 列，composite 母题的
//     材料即 prompt_md → 母题 stem 区直接编辑 prompt_md，不单设 passage 编辑器。
//   • difficulty ←→ difficulty（1-5）；knowledge ←→ knowledge_ids + labels（中文名）。
//   • status（active/draft）←→ draft_status（NULL≡active / 'draft'≡草稿）。
//   • kind ←→ kind（真 QuestionKind enum 9 值）；source ←→ source（真 13 值，只读展示）。
//   • 变体家族 ←→ family.members（root + variants，is_self 标当前）。
//   • composite 小题 ←→ parts（part_index 序）；parent 面包屑 ←→ parent_question_id +
//     part_index。
//   • 关联状态 ←→ timeline（attempt/review 事件）+ backlinks（卷引用 artifact）+
//     scheduling（FSRS due）。删除约束计数 ←→ DELETE 409 的 associations（attempts/
//     mistakes/fsrs_cards/paper_refs）。
//
// ── DEFER（注释标明）─────────────────────────────────────────────────────────
//   • AI「生成变体」button → disabled + tooltip（需后端 quiz_gen variant trigger）。
//   • figure 拖拽上传 → 仅显示 QFigure（无 upload 接线）。
//   • mcq 正确答案高亮 → 从 reference_md 首字母解析（best-effort），编辑落 reference_md。
//   • answerNote / origin（变体生成理由置信度）→ 后端无对应列，不渲。

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './questions.css';

import {
  type DeleteQuestionResult,
  type QuestionAssociationCounts,
  type QuestionFullDetail,
  deleteQuestion,
  getQuestionFull,
  patchQuestion,
} from './practice-api';

// ── 映射（对照 QuestionsPage / data-questions.jsx，用真 enum）─────────────────
type Tone = 'neutral' | 'info' | 'coral' | 'good' | 'hard' | 'again';

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

const QSOURCE: Record<string, { label: string; tone: Tone; icon: LoomIconName }> = {
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
const QSOURCE_FALLBACK = {
  label: '其它来源',
  tone: 'neutral' as Tone,
  icon: 'doc' as LoomIconName,
};
function srcMeta(source: string) {
  return QSOURCE[source] ?? QSOURCE_FALLBACK;
}

const QDIFF: Record<number, Tone> = { 1: 'good', 2: 'good', 3: 'hard', 4: 'again', 5: 'again' };
function diffTone(d: number): Tone {
  return QDIFF[d] ?? 'hard';
}

// draft_status（NULL≡active）→ 状态 badge。
function statusMeta(draftStatus: string | null): {
  key: 'active' | 'draft';
  label: string;
  tone: BadgeTone;
} {
  return draftStatus === 'draft'
    ? { key: 'draft', label: '草稿', tone: 'hard' }
    : { key: 'active', label: '正式', tone: 'good' };
}

// 是否含 markdown/latex 标记（demo qHasMarkup）→ 决定要不要渲 live 预览。
function hasMarkup(s: string | null | undefined): boolean {
  return !!s && /[*`$＿_#[\]]|\\\(|\\\[/.test(s);
}

function dateLabel(sec: number): string {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  // demo: created.replace(/-/g, " / ") → YYYY / MM / DD
  return d.toISOString().slice(0, 10).replace(/-/g, ' / ');
}

// 题面文本内嵌 markdown/latex（design QInline → MathMarkdown 单段，同 QuestionsPage）。
function QInline({ text }: { text: string }) {
  return (
    <MathMarkdown notation="latex" className="q-md-inline" style={{ display: 'inline' }}>
      {text}
    </MathMarkdown>
  );
}
function QMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <MathMarkdown notation="latex" className={className ? `q-md ${className}` : 'q-md'}>
      {text}
    </MathMarkdown>
  );
}

// 难度 pips（side rail 可点设值）。
function QDiffPips({ d }: { d: number }) {
  const tone = diffTone(d);
  return (
    <span className="qb-diff" title={`难度 ${d}`}>
      <span className="qb-diff-pips">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`qb-pip${i <= d ? ` on tone-${tone}` : ''}`} />
        ))}
      </span>
    </span>
  );
}

// ── 编辑草稿态（本地 dirty 模型；保存时 diff 出 patch）────────────────────────
interface EditDraft {
  prompt_md: string;
  reference_md: string;
  choices_md: string[];
  difficulty: number;
  knowledge_ids: string[];
  draft_status: 'active' | 'draft';
}

function draftFrom(d: QuestionFullDetail): EditDraft {
  return {
    prompt_md: d.prompt_md,
    reference_md: d.reference_md ?? '',
    choices_md: d.choices_md ?? [],
    difficulty: d.difficulty,
    knowledge_ids: [...d.knowledge_ids],
    draft_status: d.draft_status === 'draft' ? 'draft' : 'active',
  };
}

// mcq 正确答案 best-effort 解析：reference_md 若以单个字母（A-Z）开头则视为答案 key。
// 后端 choices_md 不存正确标记（DEFER 注释），故从 reference_md 推。
function answerKeyFrom(referenceMd: string): string | null {
  const m = referenceMd.trim().match(/^([A-Z])\b/);
  return m ? m[1] : null;
}
function letterFor(i: number): string {
  return String.fromCharCode(65 + i);
}

// figure 卡（DEFER：仅显示，无拖拽上传接线）。
function QFigure({ caption }: { caption: string }) {
  return (
    <div className="qd-figure">
      <div className="qd-figure-ico">
        <LoomIcon name="image" size={24} />
      </div>
      <div>
        <div className="qd-figure-cap">{caption}</div>
        {/* DEFER：figure 拖拽上传 / OCR 提取需 ingestion 接线，下一刀；此处仅展示。 */}
        <div className="qd-figure-sub">figure · 拖入图片替换 · OCR 可提取（暂未接线）</div>
      </div>
    </div>
  );
}

// ── 约束感知删除 modal ───────────────────────────────────────────────────────
function DeleteModal({
  stem,
  counts,
  pending,
  onClose,
  onConfirm,
}: {
  stem: string;
  // null = 尚未拿到约束计数（首拍 DELETE 在途）；非 null = 已知约束。
  counts: QuestionAssociationCounts | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, onClose, panelRef);

  const total = counts
    ? counts.attempts + counts.mistakes + counts.fsrs_cards + counts.paper_refs
    : 0;
  const deletable = !!counts && total === 0;
  const constraints = counts
    ? [
        counts.attempts && { n: counts.attempts, label: '条作答记录（attempt 事件）' },
        counts.fsrs_cards && { n: counts.fsrs_cards, label: '张 FSRS 复习卡' },
        counts.paper_refs && { n: counts.paper_refs, label: '份试卷引用此题' },
        counts.mistakes && { n: counts.mistakes, label: '条错题归因记录' },
      ].filter((c): c is { n: number; label: string } => !!c)
    : [];
  const canDelete = deletable || typed.trim() === '删除';

  return createPortal(
    <div className="qb-modal-wrap">
      <button
        type="button"
        aria-label="关闭"
        className="scrim open"
        style={{ zIndex: 0, border: 0, padding: 0 }}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="qb-modal"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> 需 imperative API，与 CSS-class 驱动的 portal + scrim 模式不兼容（同 DraftReviewPage / CommandPalette）。focus-trap 经 useFocusTrap 落地。
        role="dialog"
        aria-modal="true"
        aria-label="删除题目确认"
      >
        <div className="qb-modal-head">
          <span className="qb-modal-ic">
            <LoomIcon name="trash" size={18} />
          </span>
          <span className="qb-modal-title">删除此题？</span>
        </div>
        <div className="qb-modal-body">
          <div className="qb-modal-q">
            <QInline text={stem} />
          </div>
          {counts === null ? (
            <p>正在核对此题的关联记录…</p>
          ) : deletable ? (
            <>
              <p>此题没有任何关联记录，可以安全删除。</p>
              <div className="qb-modal-safe">
                <LoomIcon name="check" size={15} />无 attempt / 复习卡 / 卷引用 / 错题
              </div>
            </>
          ) : (
            <>
              <p>
                此题已被系统其他部分引用，删除会一并影响下列记录。事件日志为只读，删除将
                <strong>软删除题目并保留历史事件</strong>。
              </p>
              <div className="qb-constraints">
                {constraints.map((c) => (
                  <div key={c.label} className="qb-constraint">
                    <LoomIcon name="alert" size={14} />
                    <span className="qb-c-n">{c.n}</span> {c.label}
                  </div>
                ))}
              </div>
              <div className="qb-confirm-field">
                <div className="field-label">
                  请输入「<strong>删除</strong>」以确认
                </div>
                <input
                  className="qb-confirm-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="删除"
                  // biome-ignore lint/a11y/noAutofocus: modal 内确认输入，focus-trap 内安全（同 design screen-question-detail）
                  autoFocus
                />
              </div>
            </>
          )}
        </div>
        <div className="qb-modal-foot">
          <Btn variant="ghost" onClick={onClose}>
            取消
          </Btn>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!canDelete || pending || counts === null}
            onClick={onConfirm}
          >
            <LoomIcon name="trash" size={15} />
            {pending ? '删除中…' : deletable ? '删除' : '软删除并保留事件'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 变体家族（side）────────────────────────────────────────────────────────
function VariantFamily({
  family,
  selfKind,
  go,
}: {
  family: QuestionFullDetail['family'];
  selfKind: string;
  go: (to: string) => void;
}) {
  // 仅自己（无其他成员）→ 空态 + 生成变体（DEFER disabled）。
  if (family.members.length <= 1) {
    return (
      <Card pad="default">
        <EmptyState
          icon="sparkle"
          title="尚无变体"
          text="让 AI 基于此题或它的错因生成同型变体，形成变体家族。"
          action={
            // DEFER：需后端 quiz_gen variant trigger，下一刀。
            <Btn
              size="sm"
              variant="primary"
              icon="sparkle"
              disabled
              title="需后端变体生成接线，下一刀"
            >
              生成变体
            </Btn>
          }
        />
      </Card>
    );
  }
  return (
    <Card pad="default">
      {family.members.map((m) => {
        const variant = m.id !== family.root_question_id;
        const km = kindMeta(m.kind === 'question_part' ? selfKind : m.kind);
        return (
          <div
            key={m.id}
            className={`qd-fam-node${variant ? ' variant' : ''}${m.is_self ? ' is-current' : ''}`}
          >
            <span className="qd-fam-dot" />
            <button
              type="button"
              className="qd-fam-link"
              disabled={m.is_self}
              onClick={() => !m.is_self && go(`/questions/${m.id}`)}
            >
              {/* family 投影无 stem，用 id + kind 标识（detail 投影只给成员 id/kind/depth）。 */}
              <div className="qd-fam-t">{m.is_self ? '当前题' : `变体题 ${m.id.slice(-6)}`}</div>
            </button>
            <span className="badge tone-neutral" style={{ flex: 'none' }}>
              {km.label}
            </span>
            {m.is_self && <span className="qd-fam-cur">当前</span>}
          </div>
        );
      })}
      <div style={{ marginTop: 'var(--s-3)', display: 'flex', justifyContent: 'center' }}>
        {/* DEFER：再生成变体同样需后端 trigger。 */}
        <Btn size="sm" variant="ghost" icon="sparkle" disabled title="需后端变体生成接线，下一刀">
          再生成一个变体
        </Btn>
      </div>
    </Card>
  );
}

// ── 主面 ───────────────────────────────────────────────────────────────────
export interface QuestionDetailPageProps {
  id: string;
  navigate: (to: string) => void;
}

export default function QuestionDetailPage({ id, navigate }: QuestionDetailPageProps) {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: ['question-detail', id],
    queryFn: () => getQuestionFull(id),
  });
  const data = detailQ.data;

  // 编辑草稿态。data 到达 / 切换 id 时重置。
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saved, setSaved] = useState(false);
  const [editOptIdx, setEditOptIdx] = useState(-1);
  const [showAddChip, setShowAddChip] = useState(false);
  const [chipDraft, setChipDraft] = useState('');
  const [del, setDel] = useState(false);
  const [delCounts, setDelCounts] = useState<QuestionAssociationCounts | null>(null);

  useEffect(() => {
    if (data) setDraft(draftFrom(data));
    setSaved(false);
    setEditOptIdx(-1);
    setShowAddChip(false);
    setChipDraft('');
  }, [data]);

  // dirty 判定：草稿与服务端值逐字段比对。
  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    const base = draftFrom(data);
    return (
      base.prompt_md !== draft.prompt_md ||
      base.reference_md !== draft.reference_md ||
      base.difficulty !== draft.difficulty ||
      base.draft_status !== draft.draft_status ||
      base.choices_md.length !== draft.choices_md.length ||
      base.choices_md.some((c, i) => c !== draft.choices_md[i]) ||
      base.knowledge_ids.length !== draft.knowledge_ids.length ||
      base.knowledge_ids.some((k, i) => k !== draft.knowledge_ids[i])
    );
  }, [data, draft]);

  // labels（中文名）按 knowledge_id 索引——draft 增删 chip 用 id，展示用 name。
  const labelName = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of data?.labels ?? []) m.set(l.id, l.name);
    return m;
  }, [data]);

  const patchMut = useMutation({
    mutationFn: (body: Parameters<typeof patchQuestion>[1]) => patchQuestion(id, body),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['question-detail', id] });
      void qc.invalidateQueries({ queryKey: ['questions-bank'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (opts: { confirm?: boolean; version?: number }) => deleteQuestion(id, opts),
  });

  if (detailQ.isError) {
    return (
      <div className="page view questions-loom">
        <button type="button" className="back-link" onClick={() => navigate('/questions')}>
          <LoomIcon name="arrowL" size={14} />
          题库
        </button>
        <Card pad="lg">
          <EmptyState
            icon="alert"
            title="题目加载失败"
            text={(detailQ.error as Error)?.message ?? '该题不存在或已被归档。'}
            action={
              <Btn variant="secondary" icon="arrowL" onClick={() => navigate('/questions')}>
                返回题库
              </Btn>
            }
          />
        </Card>
      </div>
    );
  }

  if (detailQ.isLoading || !data || !draft) {
    return (
      <div className="page view questions-loom">
        <button type="button" className="back-link" onClick={() => navigate('/questions')}>
          <LoomIcon name="arrowL" size={14} />
          题库
        </button>
        <Card pad="default">
          <SkLines rows={6} />
        </Card>
      </div>
    );
  }

  const edit = (patch: Partial<EditDraft>) => {
    setDraft((x) => (x ? { ...x, ...patch } : x));
    setSaved(false);
  };

  const save = () => {
    if (!dirty || patchMut.isPending) return;
    const base = draftFrom(data);
    // 只发改了的字段（version 必带）。
    const body: Parameters<typeof patchQuestion>[1] = { version: data.version };
    if (draft.prompt_md !== base.prompt_md) body.prompt_md = draft.prompt_md;
    if (draft.reference_md !== base.reference_md)
      body.reference_md = draft.reference_md === '' ? null : draft.reference_md;
    if (
      draft.choices_md.length !== base.choices_md.length ||
      draft.choices_md.some((c, i) => c !== base.choices_md[i])
    )
      body.choices_md = draft.choices_md.length > 0 ? draft.choices_md : null;
    if (draft.difficulty !== base.difficulty) body.difficulty = draft.difficulty;
    if (draft.draft_status !== base.draft_status) body.draft_status = draft.draft_status;
    if (
      draft.knowledge_ids.length !== base.knowledge_ids.length ||
      draft.knowledge_ids.some((k, i) => k !== base.knowledge_ids[i])
    )
      body.knowledge_ids = draft.knowledge_ids;
    patchMut.mutate(body);
  };

  // 删除：打开 modal → 首拍 DELETE（无 confirm）拿约束计数 → 用户确认 → confirm 删。
  const openDelete = () => {
    setDel(true);
    setDelCounts(null);
    deleteMut.mutate(
      { confirm: false },
      {
        onSuccess: (res: DeleteQuestionResult) => {
          // 无 confirm 必返 confirm_required（含约束计数）；理论上不会 archived。
          if (res.kind === 'confirm_required') setDelCounts(res.associations);
          else setDelCounts(res.associations); // 兜底（confirm 门总返计数）。
        },
      },
    );
  };

  const confirmDelete = () => {
    deleteMut.mutate(
      { confirm: true, version: data.version },
      {
        onSuccess: (res: DeleteQuestionResult) => {
          if (res.kind === 'archived') {
            setDel(false);
            void qc.invalidateQueries({ queryKey: ['questions-bank'] });
            // 小题删后回 parent，否则回题库。
            navigate(
              data.parent_question_id ? `/questions/${data.parent_question_id}` : '/questions',
            );
          }
        },
      },
    );
  };

  const k = kindMeta(data.kind);
  const src = srcMeta(data.source);
  const status = statusMeta(draft.draft_status);
  const isComposite = data.parts.length > 0;
  const isMcq = data.kind === 'choice';
  const isPart = !!data.parent_question_id;
  const isVariant = data.variant_depth > 0 && !isPart;
  const isRoot = data.root_question_id === null && !isPart;
  const variantCount = Math.max(0, data.family.variant_count - 1);
  const answerKey = isMcq ? answerKeyFrom(draft.reference_md) : null;

  // 关联状态计数（side rail）——读 detail 聚合（timeline/backlinks/scheduling）。
  // 与删除约束门的 associations 计数同源不同投影：这里用 detail 聚合，删除 modal 用
  // DELETE 409 的精确计数（首拍拿）。
  const attemptN = data.timeline.filter((t) => t.kind === 'attempt').length;
  const reviewN = data.timeline.filter((t) => t.kind === 'review').length;
  const mistakeN = data.timeline.filter(
    (t) => t.kind === 'attempt' && t.outcome === 'failure',
  ).length;
  const paperN = data.backlinks.length;

  return (
    <div className="page view questions-loom">
      <button type="button" className="back-link" onClick={() => navigate('/questions')}>
        <LoomIcon name="arrowL" size={14} />
        题库
      </button>

      <div className="page-head">
        <div className="eyebrow">
          QUESTION · {data.id} · {k.label} · {src.label}
        </div>
        <div className="page-head-row">
          <div className="qd-head-meta">
            <Badge tone={status.tone}>{status.label}</Badge>
            {isComposite && (
              <Badge tone="info">
                <LoomIcon name="layers" size={12} />
                大题 · {data.parts.length} 小题
              </Badge>
            )}
            {isVariant && (
              <Badge tone="info">
                <LoomIcon name="sparkle" size={12} />
                AI 变体 · 深度 {data.variant_depth}
              </Badge>
            )}
            {isRoot && variantCount > 0 && (
              <Badge tone="coral">
                <LoomIcon name="sparkle" size={12} />
                母题 · {variantCount} 变体
              </Badge>
            )}
            <QDiffPips d={draft.difficulty} />
          </div>
          <div className="hero-cta">
            {saved && !dirty && (
              <span
                className="meta"
                style={{
                  color: 'var(--good-ink)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <LoomIcon name="check" size={14} />
                已保存
              </span>
            )}
            <Btn
              variant={dirty ? 'primary' : 'secondary'}
              icon="check"
              onClick={save}
              disabled={!dirty || patchMut.isPending}
            >
              {patchMut.isPending ? '保存中…' : '保存修改'}
            </Btn>
          </div>
        </div>
      </div>

      {/* parent 面包屑（小题 → 大题）*/}
      {isPart && data.parent_question_id && (
        <button
          type="button"
          className="qd-sub"
          style={{ marginBottom: 'var(--s-4)' }}
          onClick={() => navigate(`/questions/${data.parent_question_id}`)}
        >
          <span className="qd-sub-idx">
            <LoomIcon name="arrowL" size={13} />
          </span>
          <span className="qd-sub-body">
            <span className="meta">
              所属大题{data.part_index != null ? ` · 第 ${data.part_index + 1} 小题` : ''}
            </span>
            <div className="qd-sub-stem">返回大题</div>
          </span>
          <LoomIcon name="arrow" size={14} className="thread-arrow" />
        </button>
      )}

      <div className="kd-grid">
        <div className="kd-main">
          {/* stem / 题面 */}
          <div className="qd-sec">
            <div className="qd-sec-h">
              <LoomIcon name="quiz" size={14} />
              {isComposite ? '阅读材料 / 题面 prompt' : '题面 stem'} · Markdown + LaTeX
            </div>
            <div className="qd-edit">
              <textarea
                className="qd-textarea"
                value={draft.prompt_md}
                onChange={(e) => edit({ prompt_md: e.target.value })}
                rows={isComposite ? 5 : 4}
              />
              {hasMarkup(draft.prompt_md) && (
                <div className="qd-preview">
                  <div className="qd-preview-tag">
                    <LoomIcon name="eye" size={12} />
                    预览 · 含公式 / 格式
                  </div>
                  <QMarkdown text={draft.prompt_md} className="wenyan" />
                </div>
              )}
            </div>
            {/* figure（DEFER：仅显示 figures[0].caption，无 upload）*/}
            {Array.isArray(data.figures) && data.figures.length > 0 && (
              <div style={{ marginTop: 'var(--s-3)' }}>
                <QFigure
                  caption={
                    (data.figures[0] as { caption?: string })?.caption ??
                    `图 · ${data.image_refs.length || 1} 张`
                  }
                />
              </div>
            )}
          </div>

          {/* options（mcq）*/}
          {isMcq && draft.choices_md.length > 0 && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="list" size={14} />
                选项 · 点击字母设为正确答案
                <Btn
                  size="sm"
                  variant="ghost"
                  icon="plus"
                  className="qd-sec-act"
                  onClick={() => edit({ choices_md: [...draft.choices_md, ''] })}
                >
                  添加选项
                </Btn>
              </div>
              <div className="qd-opts">
                {draft.choices_md.map((opt, i) => {
                  const key = letterFor(i);
                  const correct = answerKey === key;
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: choices 是定序文本串、无稳定 id，A/B/C/D 行号即语义（同 stub 先例）
                      key={i}
                      className={`qd-opt${correct ? ' correct' : ''}`}
                    >
                      <button
                        type="button"
                        className="qd-opt-key"
                        // 点字母设正确答案：写入 reference_md（后端 choices_md 无正确标记，DEFER 注释）。
                        onClick={() => edit({ reference_md: key })}
                        title="设为正确答案"
                      >
                        {key}
                      </button>
                      {editOptIdx === i ? (
                        <input
                          className="qd-opt-text"
                          // biome-ignore lint/a11y/noAutofocus: 点选项进入编辑态，focus 该输入是预期行为（同 design）
                          autoFocus
                          value={opt}
                          onChange={(e) =>
                            edit({
                              choices_md: draft.choices_md.map((o, j) =>
                                j === i ? e.target.value : o,
                              ),
                            })
                          }
                          onBlur={() => setEditOptIdx(-1)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setEditOptIdx(-1);
                          }}
                          style={{ borderBottom: '1px solid var(--coral-line)' }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="qd-opt-text"
                          onClick={() => setEditOptIdx(i)}
                          title="点击编辑"
                          style={{
                            cursor: 'text',
                            textAlign: 'left',
                            background: 'none',
                            border: 0,
                          }}
                        >
                          <QInline text={opt} />
                        </button>
                      )}
                      {correct && (
                        <span className="qd-opt-correct-tag">
                          <LoomIcon name="check" size={12} />
                          正确
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 参考答案（非 composite）*/}
          {!isComposite && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="checkCircle" size={14} />
                参考答案
              </div>
              <textarea
                className="qd-textarea"
                value={draft.reference_md}
                onChange={(e) => edit({ reference_md: e.target.value })}
                rows={2}
                style={{ marginBottom: 'var(--s-3)' }}
              />
              {hasMarkup(draft.reference_md) && (
                <div className="qd-answer">
                  <QMarkdown text={draft.reference_md} />
                </div>
              )}
            </div>
          )}

          {/* composite 小题 */}
          {isComposite && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="layers" size={14} />
                小题 · {data.parts.length} 道
              </div>
              <div className="qd-subs">
                {data.parts.map((c) => {
                  const ck = kindMeta(c.kind === 'question_part' ? data.kind : c.kind);
                  const cs = statusMeta(c.draft_status);
                  return (
                    <button
                      type="button"
                      key={c.id}
                      className="qd-sub"
                      onClick={() => navigate(`/questions/${c.id}`)}
                    >
                      <span className="qd-sub-idx">{c.part_index + 1}</span>
                      <span className="qd-sub-body">
                        <div className="qd-sub-stem">
                          <QInline text={c.prompt_md} />
                        </div>
                        <div className="qd-sub-meta">
                          <span className="badge tone-neutral">{ck.label}</span>
                          <Badge tone={cs.tone}>{cs.label}</Badge>
                        </div>
                      </span>
                      <LoomIcon name="arrow" size={14} className="thread-arrow" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 变体家族（root / 非小题才显示）*/}
          {!isPart && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="sparkle" size={14} />
                变体家族 lineage
              </div>
              <VariantFamily family={data.family} selfKind={data.kind} go={navigate} />
            </div>
          )}
        </div>

        {/* side rail */}
        <div className="kd-side qd-side">
          <div className="qd-sec-h">
            <LoomIcon name="settings" size={14} />
            属性
          </div>
          <Card pad="default">
            <div className="qd-prop">
              <div className="qd-prop-l">题型</div>
              <div className="qd-prop-val">
                <LoomIcon name={k.icon} size={15} />
                {k.label}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">状态</div>
              {/* 设计源用全局 .seg.seg-sm；app 里 .seg 与 legacy 冲突且无 .on 容器态。
                  改用已 port 的 .qd-diffset 同款分段（bordered button + .on 珊瑚填充），
                  与下方难度切换视觉同构，复用现成 CSS 不新增。 */}
              <div className="qd-diffset">
                {(
                  [
                    ['active', '正式'],
                    ['draft', '草稿'],
                  ] as const
                ).map(([s, l]) => (
                  <button
                    type="button"
                    key={s}
                    className={draft.draft_status === s ? 'on' : ''}
                    onClick={() => edit({ draft_status: s })}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">难度 1–5</div>
              <div className="qd-diffset">
                {[1, 2, 3, 4, 5].map((d) => (
                  <button
                    type="button"
                    key={d}
                    className={draft.difficulty === d ? 'on' : ''}
                    onClick={() => edit({ difficulty: d })}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">
                知识点 <span className="meta">· 关联知识图谱</span>
              </div>
              <div className="qd-chipset">
                {draft.knowledge_ids.map((kid) => (
                  // 设计源 .qd-chip 是单 <button>，但内嵌「点 chip 跳知识点 + 点 ×
                  // 删除」是两个独立动作 → 嵌套 interactive 不合法。拆成 span 容器 +
                  // 两个裸 <button>（label 跳转 / × 删除），.qd-chip 视觉不变（generic 选择器）。
                  <span key={kid} className="qd-chip">
                    <button
                      type="button"
                      onClick={() => navigate(`/knowledge/${kid}`)}
                      style={{
                        background: 'none',
                        border: 0,
                        padding: 0,
                        color: 'inherit',
                        font: 'inherit',
                        cursor: 'pointer',
                      }}
                    >
                      {labelName.get(kid) ?? kid}
                    </button>
                    <button
                      type="button"
                      aria-label={`移除知识点 ${labelName.get(kid) ?? kid}`}
                      onClick={() =>
                        edit({ knowledge_ids: draft.knowledge_ids.filter((x) => x !== kid) })
                      }
                      style={{
                        background: 'none',
                        border: 0,
                        padding: 0,
                        display: 'inline-flex',
                        cursor: 'pointer',
                        color: 'inherit',
                      }}
                    >
                      <LoomIcon name="close" size={11} />
                    </button>
                  </span>
                ))}
                {showAddChip ? (
                  <input
                    className="qd-chip"
                    // biome-ignore lint/a11y/noAutofocus: 点「添加」展开输入，focus 是预期（同选项编辑）
                    autoFocus
                    value={chipDraft}
                    placeholder="知识点 id…"
                    onChange={(e) => setChipDraft(e.target.value)}
                    onBlur={() => {
                      const v = chipDraft.trim();
                      if (v && !draft.knowledge_ids.includes(v))
                        edit({ knowledge_ids: [...draft.knowledge_ids, v] });
                      setChipDraft('');
                      setShowAddChip(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        setChipDraft('');
                        setShowAddChip(false);
                      }
                    }}
                    style={{ minWidth: 100 }}
                  />
                ) : (
                  <button
                    type="button"
                    className="qd-chip qd-chip-add"
                    onClick={() => setShowAddChip(true)}
                  >
                    <LoomIcon name="plus" size={11} />
                    添加
                  </button>
                )}
              </div>
              {/* knowledge_ids 编辑以裸 id 录入（后端校验非归档存在性，缺名→裸 id 兜底，
                  不 fabricate）。知识点选择器（图谱搜索）= DEFER。 */}
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">来源</div>
              <div className="qd-prop-val">
                <LoomIcon name={src.icon} size={15} />
                {src.label}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">创建时间</div>
              <div className="qd-prop-time">{dateLabel(data.created_at_sec)}</div>
            </div>
          </Card>

          <div className="qd-sec-h" style={{ marginTop: 'var(--s-4)' }}>
            <LoomIcon name="link" size={14} />
            关联状态
          </div>
          <Card pad="default">
            <div className="qd-assoc">
              <div className="qd-assoc-cell">
                <span className={`qd-assoc-n${attemptN ? ' hot' : ''}`}>{attemptN}</span>
                <span className="qd-assoc-l">作答次数</span>
              </div>
              <div className="qd-assoc-cell">
                <span className="qd-assoc-n">{reviewN}</span>
                <span className="qd-assoc-l">复习记录</span>
              </div>
              <div className="qd-assoc-cell">
                <span className={`qd-assoc-n${mistakeN ? ' hot' : ''}`}>{mistakeN}</span>
                <span className="qd-assoc-l">错题记录</span>
              </div>
              <div className="qd-assoc-cell">
                <span className="qd-assoc-n">{paperN}</span>
                <span className="qd-assoc-l">卷引用</span>
              </div>
            </div>
            {data.backlinks.length > 0 && (
              <div className="qd-paperlist">
                {data.backlinks.map((p) => (
                  <div key={p.artifact_id} className="qd-paperrow">
                    <LoomIcon name="doc" size={13} />
                    {p.title}
                  </div>
                ))}
              </div>
            )}
            {/* scheduling：每知识点 FSRS due（detail 聚合）；有则展示最近 due。 */}
            {data.scheduling.per_knowledge.some((pk) => pk.due_at_sec != null) && (
              <div className="qd-paperlist">
                {data.scheduling.per_knowledge
                  .filter((pk) => pk.due_at_sec != null)
                  .map((pk) => (
                    <div key={pk.knowledge_id} className="qd-paperrow">
                      <LoomIcon name="clock" size={13} />
                      {pk.name ?? pk.knowledge_id} · 下次 {dateLabel(pk.due_at_sec ?? 0)}
                    </div>
                  ))}
              </div>
            )}
            {reviewN > 0 && (
              <Btn
                size="sm"
                variant="ghost"
                icon="review"
                block
                onClick={() => navigate('/practice')}
                style={{ marginTop: 'var(--s-3)' }}
              >
                去复习此题
              </Btn>
            )}
          </Card>

          <div className="qd-sec-h" style={{ marginTop: 'var(--s-4)', color: 'var(--again-ink)' }}>
            <LoomIcon name="trash" size={14} />
            删除
          </div>
          <Card pad="default" className="qd-danger">
            <div
              className="meta"
              style={{ marginBottom: 'var(--s-3)', lineHeight: 'var(--lh-prose)' }}
            >
              删除题目会跑一遍关联约束检查；若有作答 / 复习 / 卷引用 /
              错题记录，将软删除并保留历史事件。
            </div>
            <Btn size="sm" variant="secondary" icon="trash" block onClick={openDelete}>
              删除题目…
            </Btn>
          </Card>
        </div>
      </div>

      {del && (
        <DeleteModal
          stem={data.prompt_md}
          counts={delCounts}
          pending={deleteMut.isPending}
          onClose={() => setDel(false)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
