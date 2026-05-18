'use client';

import { VisionTab } from '@/ui/components/VisionTab';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { TabBar } from '@/ui/primitives/TabBar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

type ModeTab = 'context' | 'manual' | 'vision_single' | 'vision_paper';

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

const RECORD_KINDS = [
  { id: 'open_question', label: '疑问', tone: 'info' },
  { id: 'insight', label: '顿悟', tone: 'good' },
  { id: 'reflection', label: '反思', tone: 'coral' },
  { id: 'resource_note', label: '资料', tone: 'neutral' },
] as const;

type RecordKind = (typeof RECORD_KINDS)[number]['id'];
type RecordKindFilter = 'all' | RecordKind;

const RECORD_KIND_LABEL = Object.fromEntries(RECORD_KINDS.map((k) => [k.id, k.label])) as Record<
  RecordKind,
  string
>;
const RECORD_KIND_TONE = Object.fromEntries(RECORD_KINDS.map((k) => [k.id, k.tone])) as Record<
  RecordKind,
  'neutral' | 'info' | 'good' | 'coral'
>;

const RECORD_ACTIVITY: Record<RecordKind, 'ask' | 'annotate' | 'plan' | 'read'> = {
  open_question: 'ask',
  insight: 'annotate',
  reflection: 'plan',
  resource_note: 'read',
};

interface LearningRecordRow {
  id: string;
  kind: RecordKind;
  title: string | null;
  content_md: string;
  source: string;
  capture_mode: string;
  activity_kind: string;
  processing_status: 'raw' | 'linked' | 'actioned' | 'archived';
  origin_event_id: string | null;
  subject_id: string | null;
  knowledge_ids: string[];
  question_id: string | null;
  attempt_event_id: string | null;
  learning_item_id: string | null;
  artifact_id: string | null;
  source_document_id: string | null;
  asset_refs: string[];
  payload: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  version: number;
}

const MODE_TABS = [
  { id: 'context' as ModeTab, label: '学习记录' },
  { id: 'manual' as ModeTab, label: '错题' },
  { id: 'vision_single' as ModeTab, label: '拍单题' },
  { id: 'vision_paper' as ModeTab, label: '拍试卷' },
];

export default function RecordPage() {
  const [mode, setMode] = useState<ModeTab>('context');

  return (
    <main className="page wide record-page">
      <PageHeader
        title="录入"
        eyebrow="RECORD · context + attempts"
        sub="错题进入 /mistakes；疑问、顿悟、反思和资料记录进入 /records。"
      >
        <Button variant="ghost" icon="cog">
          设置
        </Button>
      </PageHeader>

      <TabBar items={MODE_TABS} active={mode} onSelect={(id) => setMode(id as ModeTab)} />

      <div className="record-tab-body">
        {mode === 'context' && <RecordContextPanel />}
        {mode === 'manual' && <ManualForm />}
        {mode === 'vision_single' && <VisionTab mode="vision_single" />}
        {mode === 'vision_paper' && <VisionTab mode="vision_paper" />}
      </div>
    </main>
  );
}

function RecordContextPanel() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<RecordKind>('open_question');
  const [filter, setFilter] = useState<RecordKindFilter>('all');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [knowledgeFilter, setKnowledgeFilter] = useState('');
  const [editing, setEditing] = useState<LearningRecordRow | null>(null);

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  const recordQueryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', '30');
    const kinds = filter === 'all' ? RECORD_KINDS.map((k) => k.id) : [filter];
    for (const k of kinds) params.append('kind', k);
    return params.toString();
  }, [filter]);

  const recordsQ = useQuery({
    queryKey: ['records', filter],
    queryFn: () => apiJson<{ rows: LearningRecordRow[] }>(`/api/records?${recordQueryString}`),
  });

  const knowledgeById = useMemo(
    () => new Map((knowledgeQ.data?.rows ?? []).map((n) => [n.id, n])),
    [knowledgeQ.data],
  );

  const filteredKnowledge = useMemo(() => {
    const f = knowledgeFilter.trim().toLowerCase();
    return (knowledgeQ.data?.rows ?? [])
      .filter(
        (n) =>
          !f ||
          n.name.toLowerCase().includes(f) ||
          (n.effective_domain ?? '').toLowerCase().includes(f),
      )
      .slice(0, 50);
  }, [knowledgeQ.data, knowledgeFilter]);

  const resetForm = () => {
    setEditing(null);
    setTitle('');
    setContent('');
    setSelectedKnowledge([]);
    setKnowledgeFilter('');
  };

  const createM = useMutation({
    mutationFn: () =>
      apiJson<LearningRecordRow>('/api/records', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          title: title.trim() ? title.trim() : null,
          content_md: content.trim(),
          source: 'manual',
          capture_mode: 'text',
          activity_kind: RECORD_ACTIVITY[kind],
          knowledge_ids: selectedKnowledge,
          payload: {},
        }),
      }),
    onSuccess: (row) => {
      resetForm();
      setFilter(row.kind);
      qc.invalidateQueries({ queryKey: ['records'] });
    },
  });

  const updateM = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('no record selected');
      return apiJson<LearningRecordRow>(`/api/records/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim() ? title.trim() : null,
          content_md: content.trim(),
          knowledge_ids: selectedKnowledge,
          payload: editing.payload ?? {},
          version: editing.version,
        }),
      });
    },
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ['records'] });
    },
  });

  const archiveM = useMutation({
    mutationFn: (id: string) => apiJson(`/api/records/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      if (editing) resetForm();
      qc.invalidateQueries({ queryKey: ['records'] });
    },
  });

  const startEdit = (row: LearningRecordRow) => {
    setEditing(row);
    setKind(row.kind);
    setTitle(row.title ?? '');
    setContent(row.content_md);
    setSelectedKnowledge(row.knowledge_ids);
    setKnowledgeFilter('');
  };

  const toggleKnowledge = (id: string) => {
    setSelectedKnowledge((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const pending = createM.isPending || updateM.isPending;
  const canSubmit = content.trim().length > 0 && !pending;
  const rows = recordsQ.data?.rows ?? [];

  return (
    <div style={recordContextGridStyle}>
      <Card pad="lg" className="record-card">
        <div className="record-card-head">
          <h2>{editing ? '编辑记录' : '新增记录'}</h2>
          {editing && (
            <Button variant="quiet" size="sm" icon="x" onClick={resetForm}>
              取消
            </Button>
          )}
        </div>

        <FieldLabel>类型</FieldLabel>
        <div style={chipRowStyle}>
          {RECORD_KINDS.map((k) => (
            <button
              type="button"
              key={k.id}
              onClick={() => setKind(k.id)}
              style={chipStyle(kind === k.id)}
              disabled={editing !== null}
            >
              {k.label}
            </button>
          ))}
        </div>

        <FieldLabel>标题（可选）</FieldLabel>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === 'open_question' ? '辅助线疑问' : '一句话标题'}
          style={inputStyle}
          maxLength={160}
        />

        <FieldLabel>内容</FieldLabel>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          style={textareaStyle}
          placeholder={
            kind === 'open_question'
              ? '还没有想清楚的问题'
              : kind === 'resource_note'
                ? '资料、链接或摘录'
                : '记录当前学习上下文'
          }
          maxLength={20_000}
        />

        <FieldLabel>知识点（可选，已选 {selectedKnowledge.length}）</FieldLabel>
        <input
          type="text"
          value={knowledgeFilter}
          onChange={(e) => setKnowledgeFilter(e.target.value)}
          placeholder="搜索"
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
        <div style={chipRowStyle}>
          {filteredKnowledge.map((n) => {
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

        <div style={submitRowStyle}>
          {(createM.isError || updateM.isError) && (
            <p style={errorStyle}>
              保存失败：{((createM.error ?? updateM.error) as Error).message}
            </p>
          )}
          <Button
            variant={editing ? 'secondary' : 'primary'}
            icon={editing ? 'check' : 'plus'}
            onClick={() => (editing ? updateM.mutate() : createM.mutate())}
            disabled={!canSubmit}
          >
            {pending ? '保存中…' : editing ? '保存' : '记录'}
          </Button>
        </div>
      </Card>

      <section style={recordListSectionStyle}>
        <div style={recordListToolbarStyle}>
          <div style={chipRowStyle}>
            <button
              type="button"
              onClick={() => setFilter('all')}
              style={chipStyle(filter === 'all')}
            >
              全部
            </button>
            {RECORD_KINDS.map((k) => (
              <button
                type="button"
                key={k.id}
                onClick={() => setFilter(k.id)}
                style={chipStyle(filter === k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            onClick={() => recordsQ.refetch()}
            disabled={recordsQ.isFetching}
          >
            刷新
          </Button>
        </div>

        {recordsQ.isLoading && <p style={mutedStyle}>正在加载记录…</p>}
        {recordsQ.isError && (
          <Card>
            <p style={errorStyle}>加载失败：{(recordsQ.error as Error).message}</p>
          </Card>
        )}
        {recordsQ.isSuccess && rows.length === 0 && (
          <Card>
            <p style={emptyStateStyle}>暂无记录。</p>
          </Card>
        )}

        <div style={recordListStyle}>
          {rows.map((row) => (
            <Card key={row.id} elevated>
              <div style={recordRowHeadStyle}>
                <div style={recordTitleBlockStyle}>
                  <Badge tone={RECORD_KIND_TONE[row.kind]}>{RECORD_KIND_LABEL[row.kind]}</Badge>
                  <strong style={recordTitleStyle}>
                    {row.title?.trim() || row.content_md.split('\n')[0].slice(0, 42)}
                  </strong>
                </div>
                <span style={recordDateStyle}>{formatRecordTime(row.created_at)}</span>
              </div>

              <p style={recordContentStyle}>{row.content_md}</p>

              {row.knowledge_ids.length > 0 && (
                <div style={chipRowStyle}>
                  {row.knowledge_ids.map((id) => (
                    <span key={id} style={knowledgePillStyle}>
                      {knowledgeById.get(id)?.name ?? id}
                    </span>
                  ))}
                </div>
              )}

              <div style={recordActionRowStyle}>
                <Button variant="quiet" size="sm" icon="pen" onClick={() => startEdit(row)}>
                  编辑
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon="trash"
                  onClick={() => archiveM.mutate(row.id)}
                  disabled={archiveM.isPending}
                >
                  归档
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
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
    <Card pad="lg" className="record-card manual-card">
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

function formatRecordTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const recordContextGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
  gap: 'var(--s-4)',
  alignItems: 'start',
};

const recordListSectionStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-3)',
};

const recordListToolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  flexWrap: 'wrap',
};

const recordListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 'var(--s-3)',
};

const recordRowHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 'var(--s-2)',
  alignItems: 'flex-start',
};

const recordTitleBlockStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  flexWrap: 'wrap',
};

const recordTitleStyle: React.CSSProperties = {
  minWidth: 0,
  fontSize: 'var(--fs-body)',
  fontWeight: 600,
  color: 'var(--ink)',
  overflowWrap: 'anywhere',
};

const recordDateStyle: React.CSSProperties = {
  flexShrink: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
};

const recordContentStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  color: 'var(--ink-2)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-prose)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

const recordActionRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 'var(--s-2)',
  marginTop: 'var(--s-2)',
};

const knowledgePillStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '4px 8px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line-soft)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink-3)',
  overflowWrap: 'anywhere',
};

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

const emptyStateStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--again-ink)',
};
