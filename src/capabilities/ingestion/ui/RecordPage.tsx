// M1-T6 (YUK-314) — 新栈录入面（Vite SPA 壳挂 /record）。
// 采伐自旧 Next record 页（app/(app)/record/page.tsx，T7 已拆除）：学习记录
// mode（RecordContextPanel）按 D11 不迁（学习记录已删，错题是标记不是通道）；
// manual / 拍单题 / 拍试卷 / AI 录入四 tab 保持旧行为。路由耦合走 props 注入
//（壳层规则，见 web/src/router.tsx）。

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QUESTION_KIND_OPTIONS, type QuestionKindOptionId } from '@/core/schema/business';
import { AutoEnrolledPanel } from '@/ui/components/AutoEnrolledPanel';
import {
  RecordLanding,
  type RecordLandingKnowledge,
  knowledgeLabelsFor,
} from '@/ui/components/RecordLanding';
import { AttachmentStrip } from '@/ui/components/response/AttachmentStrip';
import {
  type EvidenceAttachment,
  evidenceKindFromMime,
} from '@/ui/components/response/response-types';
import { VisionTab, type VisionTabRouting } from '@/ui/components/VisionTab';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { uploadAsset } from '@/ui/lib/assets';
import { causeOptionsForSelectedKnowledge } from '@/ui/lib/cause-options';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { TabBar } from '@/ui/primitives/TabBar';

type ModeTab = 'manual' | 'vision_single' | 'vision_paper';

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

// QUESTION_KIND_OPTIONS / QuestionKindOptionId consolidated to
// @/core/schema/business (YUK-387 Step 0). Local alias keeps the rest of this
// file's call sites unchanged.
const QUESTION_KINDS = QUESTION_KIND_OPTIONS;

type QuestionKindId = QuestionKindOptionId;
type CauseCategoryId = string;

const MODE_TABS = [
  { id: 'manual' as ModeTab, label: '错题' },
  { id: 'vision_single' as ModeTab, label: '拍单题' },
  { id: 'vision_paper' as ModeTab, label: '拍试卷' },
];

export interface RecordPageProps extends VisionTabRouting {}

export default function RecordPage({ navigate, getQuery, setQuery }: RecordPageProps) {
  const [mode, setMode] = useState<ModeTab>('manual');
  const routing = useMemo(() => ({ navigate, getQuery, setQuery }), [navigate, getQuery, setQuery]);

  return (
    <main className="page record-page">
      <PageHeader
        title="录入"
        eyebrow="学习记录 · 手动或文件录入"
        sub="拍照、上传或手动录入，确认后收进题库并标记为错题。"
      />

      <TabBar items={MODE_TABS} active={mode} onSelect={(id) => setMode(id as ModeTab)} />

      <div className="record-tab-body">
        {mode === 'manual' && <ManualForm navigate={navigate} />}
        {mode === 'vision_single' && <VisionTab mode="vision_single" routing={routing} />}
        {mode === 'vision_paper' && <VisionTab mode="vision_paper" routing={routing} />}
      </div>

      <AutoEnrolledPanel />
    </main>
  );
}

function ManualForm({ navigate }: { navigate: (to: string) => void }) {
  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  const [questionKind, setQuestionKind] = useState<QuestionKindId>('short_answer');
  const [promptMd, setPromptMd] = useState('');
  const [referenceMd, setReferenceMd] = useState('');
  const [wrongAnswerMd, setWrongAnswerMd] = useState('');
  const [difficulty, setDifficulty] = useState(3);
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [knowledgeFilter, setKnowledgeFilter] = useState('');
  const [causePrimary, setCausePrimary] = useState<CauseCategoryId | ''>('');
  const [causeNotes, setCauseNotes] = useState('');
  // A8 (YUK-354): 成功着陆态。录入成功后不再硬跳 /mistakes，而是停在着陆视图
  // （收好了什么 / 去向 / 下一步）。null = 仍在表单态。knowledge 在 onSuccess 当时
  // 从 selectedKnowledge → label 快照下来（之后 reset 表单不影响着陆显示）。
  const [landing, setLanding] = useState<{ knowledge: RecordLandingKnowledge[] } | null>(null);
  // YUK-1051 — 错答/题面图证据不再写死 []：真附件经 uploadAsset 上传，随 POST
  // /api/mistakes 的 wrong_answer_image_refs / prompt_image_refs 落库（服务端契约早已收）。
  const [promptEvidence, setPromptEvidence] = useState<EvidenceAttachment[]>([]);
  const [wrongEvidence, setWrongEvidence] = useState<EvidenceAttachment[]>([]);
  const [attachTarget, setAttachTarget] = useState<'prompt' | 'wrong' | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  // YUK-1094 — 在途附件上传计数（两个字段共用一个 input，可能连续触发）。>0 时「提交错题」
  // disable，保证 POST /api/mistakes 带的是含刚上传附件的**最新** evidence；否则提交跑在
  // 上传落定前，新附件静默丢掉。
  const [uploadingCount, setUploadingCount] = useState(0);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const allNodes = knowledgeQ.data?.rows ?? [];
  const filteredNodes = useMemo(() => {
    const f = knowledgeFilter.trim().toLowerCase();
    if (!f) return allNodes.slice(0, 50);
    return allNodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(f) || (n.effective_domain ?? '').toLowerCase().includes(f),
      )
      .slice(0, 50);
  }, [allNodes, knowledgeFilter]);
  // YUK-598 — 错因下拉行驱动（custom 科目的分类法只有 provider 行认识）。
  const { subjects: subjectRows } = useSubjects();
  const causeOptions = useMemo(
    () => causeOptionsForSelectedKnowledge(allNodes, selectedKnowledge, subjectRows),
    [allNodes, selectedKnowledge, subjectRows],
  );

  useEffect(() => {
    if (causePrimary && !causeOptions.some((option) => option.id === causePrimary)) {
      setCausePrimary('');
      setCauseNotes('');
    }
  }, [causeOptions, causePrimary]);

  const submitM = useMutation({
    mutationFn: async () =>
      apiJson<{ question_id: string; mistake_id: string; record_id: string }>('/api/mistakes', {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: promptMd.trim(),
          reference_md: referenceMd.trim() ? referenceMd.trim() : null,
          wrong_answer_md: wrongAnswerMd.trim(),
          knowledge_ids: selectedKnowledge,
          cause: causePrimary
            ? {
                primary_category: causePrimary,
                user_notes: causeNotes.trim() ? causeNotes.trim() : null,
              }
            : null,
          difficulty,
          question_kind: questionKind,
          prompt_image_refs: promptEvidence.map((a) => a.asset_id),
          wrong_answer_image_refs: wrongEvidence.map((a) => a.asset_id),
        }),
      }),
    // A8 (YUK-354): 进着陆态而非硬跳。把当时选的知识点 id → label 快照下来（手填
    // 有 selectedKnowledge + allNodes 可真实映射），供着陆「挂到哪些知识点」点击跳转。
    onSuccess: () => setLanding({ knowledge: knowledgeLabelsFor(allNodes, selectedKnowledge) }),
  });

  // A8 (YUK-354):「再录一份」—— 清空表单回到录入态（停留在录入面，不离页）。
  const resetForm = () => {
    setLanding(null);
    setPromptMd('');
    setReferenceMd('');
    setWrongAnswerMd('');
    setPromptEvidence([]);
    setWrongEvidence([]);
    setAttachError(null);
    setUploadingCount(0);
    setSelectedKnowledge([]);
    setKnowledgeFilter('');
    setCausePrimary('');
    setCauseNotes('');
    setDifficulty(3);
    submitM.reset();
  };

  const canSubmit =
    promptMd.trim().length > 0 &&
    wrongAnswerMd.trim().length > 0 &&
    selectedKnowledge.length > 0 &&
    uploadingCount === 0 &&
    !submitM.isPending;

  const toggleKnowledge = (id: string) => {
    setSelectedKnowledge((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  // YUK-1051 — 附件上传：一个隐藏 input 服务两个字段（attachTarget 区分落到题面/错答）。
  // 失败不丢已成功同批（EvidenceComposer/ProbeAnswers 同纪律）。
  const pickAttachment = async (files: FileList | null) => {
    if (!files || files.length === 0 || !attachTarget) return;
    setAttachError(null);
    setUploadingCount((c) => c + 1);
    try {
      const results = await Promise.allSettled(Array.from(files).map((f) => uploadAsset(f)));
      const uploaded = results.flatMap((r, i) => {
        if (r.status !== 'fulfilled') return [];
        const file = Array.from(files)[i];
        return [
          {
            asset_id: r.value.id,
            kind: evidenceKindFromMime(r.value.mime_type || file.type || null),
            label: file.name || undefined,
            slot_ids: null,
          } satisfies EvidenceAttachment,
        ];
      });
      if (uploaded.length > 0) {
        if (attachTarget === 'prompt') setPromptEvidence((cur) => [...cur, ...uploaded]);
        else setWrongEvidence((cur) => [...cur, ...uploaded]);
      }
      if (uploaded.length < results.length) setAttachError('部分附件上传失败，请重试');
    } finally {
      // 计数必落回（含上传抛错）；否则一次卡住的上传会永久 disable 提交入口。
      setUploadingCount((c) => Math.max(0, c - 1));
      if (attachInputRef.current) attachInputRef.current.value = '';
    }
  };

  const openAttachPicker = (target: 'prompt' | 'wrong') => {
    setAttachTarget(target);
    attachInputRef.current?.click();
  };

  if (landing) {
    // A8 (YUK-354): 手填恒为 1 道题；knowledge 真实可点（手填有 selectedKnowledge）。
    return (
      <Card pad="lg" className="record-card">
        <RecordLanding
          count={1}
          isBatch={false}
          knowledge={landing.knowledge}
          navigate={navigate}
          onRecordAnother={resetForm}
        />
      </Card>
    );
  }

  return (
    <Card pad="lg" className="record-card manual-card">
      <div className="form-row">
        <span className="field-label">题型</span>
        <div className="chip-set">
          {QUESTION_KINDS.map((k) => {
            const active = questionKind === k.id;
            return (
              <button
                type="button"
                key={k.id}
                aria-pressed={active}
                onClick={() => setQuestionKind(k.id)}
                className={active ? 'chip is-on' : 'chip'}
              >
                {active && <LoomIcon name="check" size={12} />}
                {k.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="form-row">
        {/* YUK-718 — real <label htmlFor> (mirrors EventDetailPage / DraftReviewPage)
            so the control has a programmatic name + click-to-focus. */}
        <label className="field-label" htmlFor="record-prompt-md">
          题面（必填）
        </label>
        <div className="record-composer">
          <textarea
            id="record-prompt-md"
            aria-required
            value={promptMd}
            onChange={(e) => setPromptMd(e.target.value)}
            rows={4}
            placeholder="完整题目内容…"
          />
        </div>
        <AttachmentStrip
          attachments={promptEvidence}
          onRemove={(id) => setPromptEvidence((cur) => cur.filter((a) => a.asset_id !== id))}
        />
        <div style={{ marginTop: 'var(--s-2)' }}>
          <Btn variant="ghost" size="sm" icon="camera" onClick={() => openAttachPicker('prompt')}>
            给题面附图
          </Btn>
        </div>
      </div>

      <div className="form-2col">
        <div className="form-row">
          <label className="field-label" htmlFor="record-reference-md">
            参考答案（可选）
          </label>
          <input
            id="record-reference-md"
            type="text"
            className="field-input"
            value={referenceMd}
            onChange={(e) => setReferenceMd(e.target.value)}
            placeholder="正确答案，留空 AI 不参考"
          />
        </div>
        <div className="form-row">
          <label className="field-label" htmlFor="record-wrong-answer-md">
            错答（必填）
          </label>
          <input
            id="record-wrong-answer-md"
            aria-required
            type="text"
            className="field-input field-wrong"
            value={wrongAnswerMd}
            onChange={(e) => setWrongAnswerMd(e.target.value)}
            placeholder="自己写错的答案 — AI 据此归因"
          />
          <AttachmentStrip
            attachments={wrongEvidence}
            onRemove={(id) => setWrongEvidence((cur) => cur.filter((a) => a.asset_id !== id))}
          />
          <div style={{ marginTop: 'var(--s-2)' }}>
            <Btn variant="ghost" size="sm" icon="camera" onClick={() => openAttachPicker('wrong')}>
              给错答附图
            </Btn>
          </div>
        </div>
      </div>
      <input
        ref={attachInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        multiple
        className="visually-hidden"
        aria-label="添加附件"
        onChange={(e) => void pickAttachment(e.target.files)}
      />
      {attachError && (
        <p className="record-note record-error" role="alert">
          {attachError}
        </p>
      )}

      <div className="form-row">
        <span className="field-label">
          难度 <span className="meta">{difficulty} / 5</span>
        </span>
        <input
          type="range"
          className="slider"
          min={1}
          max={5}
          step={1}
          value={difficulty}
          onChange={(e) => setDifficulty(Number(e.target.value))}
          aria-label="难度"
        />
        <div className="slider-ticks mono">
          <span>1 易</span>
          <span>3 中</span>
          <span>5 难</span>
        </div>
      </div>

      <div className="form-row">
        <span className="field-label">知识点（至少 1 个，已选 {selectedKnowledge.length}）</span>
        {/* YUK-718 — the field-label names the chip GROUP, so the search box carries
            its own per-control aria-label; it repeats the min-1 requirement + live
            selected-count the visible label shows (htmlFor to a group is impractical). */}
        <input
          type="text"
          className="field-input"
          value={knowledgeFilter}
          onChange={(e) => setKnowledgeFilter(e.target.value)}
          placeholder="按知识点名称搜索"
          aria-label={`知识点搜索（至少 1 个，已选 ${selectedKnowledge.length}）`}
        />
        {knowledgeQ.isLoading && <p className="record-note record-muted">正在加载知识点…</p>}
        {knowledgeQ.isError && (
          <p className="record-note record-error">
            {knowledgeQ.error instanceof ApiAuthError
              ? `${knowledgeQ.error.message} — 请重新进入页面输入 token`
              : `加载知识点失败：${(knowledgeQ.error as Error).message}`}
          </p>
        )}
        {knowledgeQ.isSuccess && filteredNodes.length === 0 && (
          <p className="record-note record-muted">没有匹配的节点。</p>
        )}
        <div className="chip-set">
          {filteredNodes.map((n) => {
            const selected = selectedKnowledge.includes(n.id);
            return (
              <button
                type="button"
                key={n.id}
                onClick={() => toggleKnowledge(n.id)}
                className={selected ? 'chip is-on' : 'chip'}
                title={n.effective_domain ?? ''}
              >
                {selected && <LoomIcon name="check" size={12} />}
                {n.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="form-row">
        <span className="field-label">错因（可选，留空 AI 兜底归因）</span>
        <div className="chip-set">
          <button
            type="button"
            onClick={() => setCausePrimary('')}
            className={causePrimary === '' ? 'chip is-on' : 'chip'}
          >
            {causePrimary === '' && <LoomIcon name="check" size={12} />}
            不指定
          </button>
          {causeOptions.map((c) => {
            const active = causePrimary === c.id;
            return (
              <button
                type="button"
                key={c.id}
                onClick={() => setCausePrimary(c.id)}
                className={active ? 'chip is-on' : 'chip'}
              >
                {active && <LoomIcon name="check" size={12} />}
                {c.label}
              </button>
            );
          })}
        </div>
        {causePrimary && (
          <div className="record-composer" style={{ marginTop: 'var(--s-2)' }}>
            <textarea
              value={causeNotes}
              onChange={(e) => setCauseNotes(e.target.value)}
              rows={2}
              placeholder="补充说明（可选）"
            />
          </div>
        )}
      </div>

      {submitM.isError && (
        <p className="record-note record-error">提交失败：{(submitM.error as Error).message}</p>
      )}
      <div className="hero-cta">
        <Btn variant="primary" icon="check" onClick={() => submitM.mutate()} disabled={!canSubmit}>
          {submitM.isPending ? '提交中…' : '提交错题'}
        </Btn>
      </div>
    </Card>
  );
}
