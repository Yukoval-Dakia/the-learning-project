// M1-T6 (YUK-314) — 新栈录入面（Vite SPA 壳挂 /record）。
// 采伐自旧 Next record 页（app/(app)/record/page.tsx，T7 已拆除）：学习记录
// mode（RecordContextPanel）按 D11 不迁（学习记录已删，错题是标记不是通道）；
// manual / 拍单题 / 拍试卷 / AI 录入四 tab 保持旧行为。路由耦合走 props 注入
//（壳层规则，见 web/src/router.tsx）。

import { AutoEnrolledPanel } from '@/ui/components/AutoEnrolledPanel';
import { VisionTab, type VisionTabRouting } from '@/ui/components/VisionTab';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { causeOptionsForSelectedKnowledge } from '@/ui/lib/cause-options';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { TabBar } from '@/ui/primitives/TabBar';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

type ModeTab = 'manual' | 'vision_single' | 'vision_paper' | 'auto_enrolled';

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

const QUESTION_KINDS = [
  { id: 'choice', label: '选择' },
  { id: 'true_false', label: '判断' },
  { id: 'fill_blank', label: '填空' },
  { id: 'short_answer', label: '简答' },
  { id: 'essay', label: '论述' },
  { id: 'computation', label: '计算' },
  { id: 'reading', label: '阅读' },
  { id: 'translation', label: '翻译' },
] as const;

type QuestionKindId = (typeof QUESTION_KINDS)[number]['id'];
type CauseCategoryId = string;

const MODE_TABS = [
  { id: 'manual' as ModeTab, label: '错题' },
  { id: 'vision_single' as ModeTab, label: '拍单题' },
  { id: 'vision_paper' as ModeTab, label: '拍试卷' },
  { id: 'auto_enrolled' as ModeTab, label: 'AI 录入' },
];

export interface RecordPageProps extends VisionTabRouting {}

export default function RecordPage({ navigate, getQuery, setQuery }: RecordPageProps) {
  const [mode, setMode] = useState<ModeTab>('manual');
  const routing = useMemo(() => ({ navigate, getQuery, setQuery }), [navigate, getQuery, setQuery]);

  return (
    <main className="page record-page">
      <PageHeader title="录入" eyebrow="RECORD · attempts" sub="错题进入 /mistakes。">
        <Button variant="ghost" icon="cog">
          设置
        </Button>
      </PageHeader>

      <TabBar items={MODE_TABS} active={mode} onSelect={(id) => setMode(id as ModeTab)} />

      <div className="record-tab-body">
        {mode === 'manual' && <ManualForm navigate={navigate} />}
        {mode === 'vision_single' && <VisionTab mode="vision_single" routing={routing} />}
        {mode === 'vision_paper' && <VisionTab mode="vision_paper" routing={routing} />}
        {mode === 'auto_enrolled' && <AutoEnrolledPanel />}
      </div>
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
  const causeOptions = useMemo(
    () => causeOptionsForSelectedKnowledge(allNodes, selectedKnowledge),
    [allNodes, selectedKnowledge],
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
          prompt_image_refs: [],
          wrong_answer_image_refs: [],
        }),
      }),
    onSuccess: () => navigate('/mistakes'),
  });

  const canSubmit =
    promptMd.trim().length > 0 &&
    wrongAnswerMd.trim().length > 0 &&
    selectedKnowledge.length > 0 &&
    !submitM.isPending;

  const toggleKnowledge = (id: string) => {
    setSelectedKnowledge((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

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
        <span className="field-label">题面（必填）</span>
        <div className="record-composer">
          <textarea
            value={promptMd}
            onChange={(e) => setPromptMd(e.target.value)}
            rows={4}
            placeholder="完整题目内容…"
          />
        </div>
      </div>

      <div className="form-2col">
        <div className="form-row">
          <span className="field-label">参考答案（可选）</span>
          <input
            type="text"
            className="field-input"
            value={referenceMd}
            onChange={(e) => setReferenceMd(e.target.value)}
            placeholder="正确答案，留空 AI 不参考"
          />
        </div>
        <div className="form-row">
          <span className="field-label">错答（必填）</span>
          <input
            type="text"
            className="field-input field-wrong"
            value={wrongAnswerMd}
            onChange={(e) => setWrongAnswerMd(e.target.value)}
            placeholder="自己写错的答案 — AI 据此归因"
          />
        </div>
      </div>

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
        <div className="slider-ticks">
          <span>1 易</span>
          <span>3 中</span>
          <span>5 难</span>
        </div>
      </div>

      <div className="form-row">
        <span className="field-label">知识点（至少 1 个，已选 {selectedKnowledge.length}）</span>
        <input
          type="text"
          className="field-input"
          value={knowledgeFilter}
          onChange={(e) => setKnowledgeFilter(e.target.value)}
          placeholder="按名字 / domain 搜索"
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
          {submitM.isPending ? '提交中…' : '提交 → /mistakes'}
        </Btn>
      </div>
    </Card>
  );
}
