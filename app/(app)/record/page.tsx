'use client';

import { VisionTab } from '@/ui/components/VisionTab';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { TabBar } from '@/ui/primitives/TabBar';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

type ModeTab = 'manual' | 'vision_single' | 'vision_paper';

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

const CAUSE_CATEGORIES = [
  { id: 'concept', label: '概念' },
  { id: 'knowledge_gap', label: '知识盲点' },
  { id: 'calculation', label: '计算' },
  { id: 'reading', label: '阅读理解' },
  { id: 'memory', label: '记忆' },
  { id: 'expression', label: '表达' },
  { id: 'method', label: '方法' },
  { id: 'carelessness', label: '粗心' },
  { id: 'time_pressure', label: '时间' },
  { id: 'other', label: '其它' },
] as const;

type QuestionKindId = (typeof QUESTION_KINDS)[number]['id'];
type CauseCategoryId = (typeof CAUSE_CATEGORIES)[number]['id'];

const MODE_TABS = [
  { id: 'manual' as ModeTab, label: '手动录入' },
  { id: 'vision_single' as ModeTab, label: '拍单题' },
  { id: 'vision_paper' as ModeTab, label: '拍整页' },
];

export default function RecordPage() {
  const [mode, setMode] = useState<ModeTab>('manual');

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 780px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader title="录入" eyebrow="/record" sub="手动 / 视觉（拍单题 + 拍整页）" />

      <div style={{ marginTop: 'var(--s-4)' }}>
        <TabBar items={MODE_TABS} active={mode} onSelect={(id) => setMode(id as ModeTab)} />
      </div>

      <div style={{ marginTop: 'var(--s-4)' }}>
        {mode === 'manual' && <ManualForm />}
        {mode === 'vision_single' && <VisionTab mode="vision_single" />}
        {mode === 'vision_paper' && <VisionTab mode="vision_paper" />}
      </div>
    </main>
  );
}

function ManualForm() {
  const router = useRouter();
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

  const submitM = useMutation({
    mutationFn: async () =>
      apiJson<{ question_id: string; mistake_id: string }>('/api/mistakes', {
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
    onSuccess: () => router.push('/mistakes'),
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
    <Card pad="lg">
      <FieldLabel>题型</FieldLabel>
      <div style={chipRowStyle}>
        {QUESTION_KINDS.map((k) => (
          <button
            type="button"
            key={k.id}
            onClick={() => setQuestionKind(k.id)}
            style={chipStyle(questionKind === k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>

      <FieldLabel>题面（必填）</FieldLabel>
      <textarea
        value={promptMd}
        onChange={(e) => setPromptMd(e.target.value)}
        rows={5}
        style={textareaStyle}
        placeholder="完整题目内容…"
      />

      <FieldLabel>参考答案（可选）</FieldLabel>
      <textarea
        value={referenceMd}
        onChange={(e) => setReferenceMd(e.target.value)}
        rows={3}
        style={textareaStyle}
        placeholder="正确答案，留空 AI 不参考"
      />

      <FieldLabel>错答（必填）</FieldLabel>
      <textarea
        value={wrongAnswerMd}
        onChange={(e) => setWrongAnswerMd(e.target.value)}
        rows={3}
        style={textareaStyle}
        placeholder="自己写错的答案 — AI 据此归因"
      />

      <FieldLabel>难度 ({difficulty})</FieldLabel>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={difficulty}
        onChange={(e) => setDifficulty(Number(e.target.value))}
        style={{ width: '100%' }}
      />

      <FieldLabel>知识点（至少 1 个，已选 {selectedKnowledge.length}）</FieldLabel>
      <input
        type="text"
        value={knowledgeFilter}
        onChange={(e) => setKnowledgeFilter(e.target.value)}
        placeholder="按名字 / domain 搜索"
        style={inputStyle}
      />
      {knowledgeQ.isLoading && <p style={mutedStyle}>正在加载知识点…</p>}
      {knowledgeQ.isError && (
        <p style={errorStyle}>
          {knowledgeQ.error instanceof ApiAuthError
            ? `${knowledgeQ.error.message} — 请重新进入页面输入 token`
            : `加载知识点失败：${(knowledgeQ.error as Error).message}`}
        </p>
      )}
      {knowledgeQ.isSuccess && filteredNodes.length === 0 && (
        <p style={mutedStyle}>没有匹配的节点。</p>
      )}
      <div style={chipRowStyle}>
        {filteredNodes.map((n) => {
          const selected = selectedKnowledge.includes(n.id);
          return (
            <button
              type="button"
              key={n.id}
              onClick={() => toggleKnowledge(n.id)}
              style={chipStyle(selected)}
              title={n.effective_domain ?? ''}
            >
              {n.name}
            </button>
          );
        })}
      </div>

      <FieldLabel>错因（可选，留空 AI 兜底归因）</FieldLabel>
      <div style={chipRowStyle}>
        <button
          type="button"
          onClick={() => setCausePrimary('')}
          style={chipStyle(causePrimary === '')}
        >
          不指定
        </button>
        {CAUSE_CATEGORIES.map((c) => (
          <button
            type="button"
            key={c.id}
            onClick={() => setCausePrimary(c.id)}
            style={chipStyle(causePrimary === c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {causePrimary && (
        <textarea
          value={causeNotes}
          onChange={(e) => setCauseNotes(e.target.value)}
          rows={2}
          style={textareaStyle}
          placeholder="补充说明（可选）"
        />
      )}

      <div style={submitRowStyle}>
        {submitM.isError && <p style={errorStyle}>提交失败：{(submitM.error as Error).message}</p>}
        <Button variant="primary" onClick={() => submitM.mutate()} disabled={!canSubmit}>
          {submitM.isPending ? '提交中…' : '提交 → /mistakes'}
        </Button>
      </div>
    </Card>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span style={fieldLabelStyle}>{children}</span>;
}

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
  display: 'block',
  marginTop: 'var(--s-4)',
  marginBottom: 'var(--s-2)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-prose)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  outline: 'none',
  boxSizing: 'border-box',
};

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s-1)',
  marginTop: 'var(--s-2)',
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontFamily: active ? 'var(--font-mono)' : 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '6px 10px',
  borderRadius: 'var(--r-pill)',
  border: `1px solid ${active ? 'var(--coral)' : 'var(--line)'}`,
  background: active ? 'var(--coral-soft)' : 'var(--paper-sunk)',
  color: active ? 'var(--coral-ink)' : 'var(--ink-2)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: 'var(--ls-wide)',
});

const submitRowStyle: React.CSSProperties = {
  marginTop: 'var(--s-5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 'var(--s-3)',
};

const mutedStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--again-ink)',
};
