'use client';

// Phase 1c.2 Vision MVP — /record vision_single + vision_paper tab body.
//
// State machine, mirrors what the addendum/spec calls Vision flow A path:
//   idle           — file picker only, no files selected
//   uploading      — uploading assets to /api/assets in parallel
//   creating       — POST /api/ingestion to create the learning_session
//   extracting     — extract triggered, listening SSE on /api/ingestion/[id]/events
//   reviewing      — extraction completed; blocks fetched; user editing per-block
//   importing      — POST /api/ingestion/[id]/import in flight
//   error          — any step above bailed; user can reset
//
// Defers (planned for 1c.2.C):
//   - cross-page block merge UI (manual merge button + selection)
//   - Tier 2 / Tier 3 rescue button per block (calls /api/ingestion/[id]/rescue)
//   - bbox-on-image overlay + tencent_grading evidence chip
//   - structured tree preview (currently we render extracted_prompt_md only)

import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import { uploadAsset } from '@/ui/lib/assets';
import { useIngestionSSE } from '@/ui/lib/sse';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

type Mode = 'vision_single' | 'vision_paper';

type Phase = 'idle' | 'uploading' | 'creating' | 'extracting' | 'reviewing' | 'importing' | 'error';

type QuestionKindId =
  | 'choice'
  | 'true_false'
  | 'fill_blank'
  | 'short_answer'
  | 'essay'
  | 'computation'
  | 'reading'
  | 'translation';

type CauseCategoryId =
  | 'concept'
  | 'knowledge_gap'
  | 'calculation'
  | 'reading'
  | 'memory'
  | 'expression'
  | 'method'
  | 'carelessness'
  | 'time_pressure'
  | 'other';

const QUESTION_KINDS: { id: QuestionKindId; label: string }[] = [
  { id: 'choice', label: '选择' },
  { id: 'true_false', label: '判断' },
  { id: 'fill_blank', label: '填空' },
  { id: 'short_answer', label: '简答' },
  { id: 'essay', label: '论述' },
  { id: 'computation', label: '计算' },
  { id: 'reading', label: '阅读' },
  { id: 'translation', label: '翻译' },
];

const CAUSE_CATEGORIES: { id: CauseCategoryId; label: string }[] = [
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
];

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

interface BlockRow {
  id: string;
  ingestion_session_id: string;
  source_asset_ids: string[];
  page_spans: Array<{
    page_index: number;
    bbox: { x: number; y: number; width: number; height: number };
    role?: string;
  }>;
  extracted_prompt_md: string | null;
  reference_md: string | null;
  wrong_answer_md: string | null;
  image_refs: string[];
  layout_quality: 'structured' | 'partial' | 'text_only';
  extraction_confidence: number;
  status: 'draft' | 'imported' | 'ignored';
  knowledge_hint: string | null;
  created_at: number;
}

interface BlockFormState {
  prompt_md: string; // editable copy seeded from extracted_prompt_md
  reference_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause_primary: CauseCategoryId | '';
  cause_notes: string;
  question_kind: QuestionKindId;
  difficulty: number;
  ignored: boolean;
}

const SSE_TERMINAL: Record<string, true> = {
  'ingestion.extraction_completed': true,
  'ingestion.extraction_failed': true,
  'ingestion.imported': true,
};

export function VisionTab({ mode }: { mode: Mode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxFiles = mode === 'vision_single' ? 1 : 5;

  const [phase, setPhase] = useState<Phase>('idle');
  const [files, setFiles] = useState<File[]>([]);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blockForms, setBlockForms] = useState<Record<string, BlockFormState>>({});
  const seededBlockIdsRef = useRef<Set<string>>(new Set());

  // SSE listener — opens once sessionId is set. Hook auto-cleans on unmount.
  const sse = useIngestionSSE(phase === 'extracting' ? sessionId : null);

  // Once any terminal event arrives, flip to reviewing (or surface error).
  useEffect(() => {
    if (phase !== 'extracting') return;
    const terminal = sse.events.find((e) => SSE_TERMINAL[e.event_type]);
    if (!terminal) return;
    if (terminal.event_type === 'ingestion.extraction_failed') {
      setErrorMessage(
        typeof terminal.payload.error_message === 'string'
          ? terminal.payload.error_message
          : '抽取失败',
      );
      setPhase('error');
      return;
    }
    setPhase('reviewing');
  }, [phase, sse.events]);

  // Fetch blocks once we move into reviewing (or when sessionId changes).
  const blocksQ = useQuery<{ rows: BlockRow[] }>({
    queryKey: ['ingestion-blocks', sessionId],
    queryFn: () => apiJson<{ rows: BlockRow[] }>(`/api/ingestion/${sessionId}/blocks`),
    enabled: phase === 'reviewing' && sessionId !== null,
  });

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  // Seed per-block form state once blocks arrive.
  useEffect(() => {
    const rows = blocksQ.data?.rows ?? [];
    if (rows.length === 0) return;
    setBlockForms((prev) => {
      const next = { ...prev };
      for (const b of rows) {
        if (seededBlockIdsRef.current.has(b.id)) continue;
        seededBlockIdsRef.current.add(b.id);
        next[b.id] = {
          prompt_md: b.extracted_prompt_md ?? '',
          reference_md: b.reference_md ?? '',
          wrong_answer_md: b.wrong_answer_md ?? '',
          knowledge_ids: [],
          cause_primary: '',
          cause_notes: '',
          question_kind: 'short_answer',
          difficulty: 3,
          ignored: false,
        };
      }
      return next;
    });
  }, [blocksQ.data]);

  const startMutation = useMutation({
    mutationFn: async (selectedFiles: File[]) => {
      // 1. upload all assets
      setPhase('uploading');
      const assets = await Promise.all(selectedFiles.map((f) => uploadAsset(f)));
      const ids = assets.map((a) => a.id);
      setAssetIds(ids);
      // 2. create session
      setPhase('creating');
      const session = await apiJson<{
        session: { id: string };
      }>('/api/ingestion', {
        method: 'POST',
        body: JSON.stringify({ entrypoint: mode, asset_ids: ids }),
      });
      // 3. trigger extract
      await apiJson(`/api/ingestion/${session.session.id}/extract`, { method: 'POST' });
      return session.session.id;
    },
    onSuccess: (id) => {
      setSessionId(id);
      setPhase('extracting');
    },
    onError: (err) => {
      setErrorMessage(formatError(err));
      setPhase('error');
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      const rows = blocksQ.data?.rows ?? [];
      const importable = rows
        .filter((b) => !blockForms[b.id]?.ignored)
        .map((b) => {
          const f = blockForms[b.id];
          if (!f) throw new Error(`block ${b.id} form missing`);
          if (!f.prompt_md.trim()) throw new Error(`block ${b.id}: 题面不能空`);
          if (!f.wrong_answer_md.trim()) throw new Error(`block ${b.id}: 错答不能空`);
          if (f.knowledge_ids.length === 0) throw new Error(`block ${b.id}: 至少选 1 个知识点`);
          const pageSpans =
            b.page_spans.length > 0
              ? b.page_spans
              : [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }];
          return {
            block_id: b.id,
            source_block_ids: [b.id],
            page_spans: pageSpans,
            image_refs: b.image_refs.length > 0 ? b.image_refs : b.source_asset_ids,
            final_prompt_md: f.prompt_md.trim(),
            final_reference_md: f.reference_md.trim() ? f.reference_md.trim() : null,
            final_wrong_answer_md: f.wrong_answer_md.trim(),
            knowledge_ids: f.knowledge_ids,
            cause: f.cause_primary
              ? {
                  primary_category: f.cause_primary,
                  user_notes: f.cause_notes.trim() ? f.cause_notes.trim() : null,
                }
              : null,
            difficulty: f.difficulty,
            question_kind: f.question_kind,
          };
        });
      if (importable.length === 0) throw new Error('至少保留一个块导入');
      return apiJson(`/api/ingestion/${sessionId}/import`, {
        method: 'POST',
        body: JSON.stringify({ blocks: importable }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mistakes'] });
      router.push('/mistakes');
    },
    onError: (err) => setErrorMessage(formatError(err)),
  });

  const onPickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const picked = Array.from(list).slice(0, maxFiles);
    setFiles(picked);
    setErrorMessage(null);
  };

  const reset = () => {
    setPhase('idle');
    setFiles([]);
    setAssetIds([]);
    setSessionId(null);
    setBlockForms({});
    seededBlockIdsRef.current = new Set();
    setErrorMessage(null);
  };

  const blocks = blocksQ.data?.rows ?? [];

  return (
    <Card pad="lg">
      <div style={headStyle}>
        <h2 style={titleStyle}>{mode === 'vision_single' ? '单题拍照' : '整页拍照'}</h2>
        <span style={metaStyle}>
          {mode === 'vision_single' ? '1 张图' : '1–5 张试卷照'} · {phaseLabel(phase, sse.status)}
        </span>
      </div>

      {(phase === 'idle' || phase === 'error') && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple={mode === 'vision_paper'}
            style={{ display: 'none' }}
            onChange={(e) => onPickFiles(e.target.files)}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} style={dropzoneStyle}>
            {files.length > 0 ? (
              <span>已选 {files.length} 张 — 点击重选</span>
            ) : (
              <span>点击选择图片（{mode === 'vision_single' ? '1 张' : '1–5 张'}）</span>
            )}
          </button>
          {files.length > 0 && (
            <ul style={fileListStyle}>
              {files.map((f) => (
                <li key={f.name} style={fileItemStyle}>
                  <span>{f.name}</span>
                  <span style={metaStyle}>{(f.size / 1024).toFixed(1)} KB</span>
                </li>
              ))}
            </ul>
          )}
          {errorMessage && <p style={errorStyle}>{errorMessage}</p>}
          <div style={{ marginTop: 'var(--s-3)', display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              onClick={() => startMutation.mutate(files)}
              disabled={files.length === 0 || startMutation.isPending}
            >
              {startMutation.isPending ? '处理中…' : '上传 + 开始抽取'}
            </Button>
          </div>
        </>
      )}

      {(phase === 'uploading' || phase === 'creating' || phase === 'extracting') && (
        <div>
          <p style={{ ...mutedStyle, marginTop: 0 }}>
            {phase === 'uploading' && `上传 ${files.length} 张图到 R2 …`}
            {phase === 'creating' && '创建 ingestion session…'}
            {phase === 'extracting' && '触发抽取，等待 worker 推进度…'}
          </p>
          <SSETimeline events={sse.events} status={sse.status} />
          {sse.error && <p style={errorStyle}>{sse.error.message}</p>}
        </div>
      )}

      {phase === 'reviewing' && (
        <div>
          <SSETimeline events={sse.events} status="closed" />
          {blocksQ.isLoading && <p style={mutedStyle}>加载块…</p>}
          {blocksQ.isError && <p style={errorStyle}>加载块失败：{formatError(blocksQ.error)}</p>}
          {blocksQ.isSuccess && blocks.length === 0 && (
            <p style={mutedStyle}>抽取完成但没有产出任何块；可能是 OCR 没有识别到题目。</p>
          )}
          {blocks.map((b, idx) => (
            <BlockEditor
              key={b.id}
              index={idx}
              block={b}
              form={blockForms[b.id]}
              setForm={(updater) =>
                setBlockForms((prev) => {
                  const cur = prev[b.id];
                  if (!cur) return prev;
                  return { ...prev, [b.id]: updater(cur) };
                })
              }
              knowledgeNodes={knowledgeQ.data?.rows ?? []}
            />
          ))}
          {errorMessage && <p style={errorStyle}>{errorMessage}</p>}
          {importMutation.isError && (
            <p style={errorStyle}>导入失败：{formatError(importMutation.error)}</p>
          )}
          <div
            style={{
              marginTop: 'var(--s-4)',
              display: 'flex',
              gap: 'var(--s-2)',
              justifyContent: 'flex-end',
            }}
          >
            <Button variant="ghost" onClick={reset} disabled={importMutation.isPending}>
              重新上传
            </Button>
            <Button
              onClick={() => importMutation.mutate()}
              disabled={blocks.length === 0 || importMutation.isPending}
            >
              {importMutation.isPending
                ? '导入中…'
                : `批量导入 · ${blocks.filter((b) => !blockForms[b.id]?.ignored).length} 道 → /mistakes`}
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div>
          <p style={errorStyle}>失败：{errorMessage ?? '未知错误'}</p>
          <div style={{ marginTop: 'var(--s-3)', display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={reset}>
              重置
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

interface BlockEditorProps {
  index: number;
  block: BlockRow;
  form: BlockFormState | undefined;
  setForm: (updater: (cur: BlockFormState) => BlockFormState) => void;
  knowledgeNodes: KnowledgeNode[];
}

function BlockEditor({ index, block, form, setForm, knowledgeNodes }: BlockEditorProps) {
  const [kFilter, setKFilter] = useState('');
  const filteredNodes = useMemo(() => {
    const f = kFilter.trim().toLowerCase();
    if (!f) return knowledgeNodes.slice(0, 30);
    return knowledgeNodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(f) || (n.effective_domain ?? '').toLowerCase().includes(f),
      )
      .slice(0, 30);
  }, [knowledgeNodes, kFilter]);

  if (!form) return null;
  const toggleKid = (id: string) =>
    setForm((cur) => ({
      ...cur,
      knowledge_ids: cur.knowledge_ids.includes(id)
        ? cur.knowledge_ids.filter((x) => x !== id)
        : [...cur.knowledge_ids, id],
    }));

  return (
    <div
      style={{
        ...blockBoxStyle,
        opacity: form.ignored ? 0.5 : 1,
      }}
    >
      <div style={blockHeadStyle}>
        <span style={blockIndexStyle}>#{index + 1}</span>
        <LayoutQualityBadge q={block.layout_quality} />
        <Badge tone="neutral">conf {(block.extraction_confidence * 100).toFixed(0)}%</Badge>
        <span style={metaStyle}>{formatRelTime(new Date(block.created_at * 1000))}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...metaStyle }}>
          <input
            type="checkbox"
            checked={form.ignored}
            onChange={(e) => setForm((cur) => ({ ...cur, ignored: e.target.checked }))}
          />
          忽略本块
        </label>
      </div>

      <FieldLabel>题面（OCR 已填，可改）</FieldLabel>
      <textarea
        value={form.prompt_md}
        onChange={(e) => setForm((cur) => ({ ...cur, prompt_md: e.target.value }))}
        rows={4}
        style={textareaStyle}
        disabled={form.ignored}
      />

      <FieldLabel>参考答案（可选）</FieldLabel>
      <textarea
        value={form.reference_md}
        onChange={(e) => setForm((cur) => ({ ...cur, reference_md: e.target.value }))}
        rows={2}
        style={textareaStyle}
        disabled={form.ignored}
      />

      <FieldLabel>错答（必填）</FieldLabel>
      <textarea
        value={form.wrong_answer_md}
        onChange={(e) => setForm((cur) => ({ ...cur, wrong_answer_md: e.target.value }))}
        rows={2}
        style={textareaStyle}
        disabled={form.ignored}
        placeholder="自己写错的答案"
      />

      <FieldLabel>题型</FieldLabel>
      <div style={chipRowStyle}>
        {QUESTION_KINDS.map((q) => (
          <button
            type="button"
            key={q.id}
            onClick={() => setForm((cur) => ({ ...cur, question_kind: q.id }))}
            style={chipStyle(form.question_kind === q.id)}
            disabled={form.ignored}
          >
            {q.label}
          </button>
        ))}
      </div>

      <FieldLabel>难度 ({form.difficulty})</FieldLabel>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={form.difficulty}
        onChange={(e) => setForm((cur) => ({ ...cur, difficulty: Number(e.target.value) }))}
        style={{ width: '100%' }}
        disabled={form.ignored}
      />

      <FieldLabel>知识点（至少 1，已选 {form.knowledge_ids.length}）</FieldLabel>
      <input
        type="text"
        value={kFilter}
        onChange={(e) => setKFilter(e.target.value)}
        placeholder="搜索"
        style={inputStyle}
        disabled={form.ignored}
      />
      <div style={chipRowStyle}>
        {filteredNodes.map((n) => (
          <button
            type="button"
            key={n.id}
            onClick={() => toggleKid(n.id)}
            style={chipStyle(form.knowledge_ids.includes(n.id))}
            disabled={form.ignored}
            title={n.effective_domain ?? ''}
          >
            {n.name}
          </button>
        ))}
      </div>

      <FieldLabel>错因（可选；留空 AI 兜底）</FieldLabel>
      <div style={chipRowStyle}>
        <button
          type="button"
          onClick={() => setForm((cur) => ({ ...cur, cause_primary: '' }))}
          style={chipStyle(form.cause_primary === '')}
          disabled={form.ignored}
        >
          不指定
        </button>
        {CAUSE_CATEGORIES.map((c) => (
          <button
            type="button"
            key={c.id}
            onClick={() => setForm((cur) => ({ ...cur, cause_primary: c.id }))}
            style={chipStyle(form.cause_primary === c.id)}
            disabled={form.ignored}
          >
            {c.label}
          </button>
        ))}
      </div>
      {form.cause_primary && (
        <textarea
          value={form.cause_notes}
          onChange={(e) => setForm((cur) => ({ ...cur, cause_notes: e.target.value }))}
          rows={2}
          style={textareaStyle}
          placeholder="补充说明（可选）"
          disabled={form.ignored}
        />
      )}
    </div>
  );
}

function LayoutQualityBadge({ q }: { q: 'structured' | 'partial' | 'text_only' }) {
  if (q === 'structured') return <Badge tone="good">structured</Badge>;
  if (q === 'partial') return <Badge tone="hard">partial</Badge>;
  return <Badge tone="hard">text_only</Badge>;
}

function SSETimeline({
  events,
  status,
}: {
  events: { event_id: number; event_type: string; payload: Record<string, unknown> }[];
  status: string;
}) {
  return (
    <ol style={timelineStyle}>
      {events.map((e) => (
        <li key={e.event_id} style={timelineItemStyle}>
          <code style={timelineCodeStyle}>{e.event_type}</code>
          {e.payload.block_count !== undefined && (
            <span style={metaStyle}> · {String(e.payload.block_count)} blocks</span>
          )}
          {typeof e.payload.layout_quality === 'string' && (
            <span style={metaStyle}> · {e.payload.layout_quality}</span>
          )}
          {typeof e.payload.error_message === 'string' && (
            <span style={errorStyle}> · {e.payload.error_message}</span>
          )}
        </li>
      ))}
      {events.length === 0 && <li style={metaStyle}>等待事件… ({status})</li>}
    </ol>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span style={fieldLabelStyle}>{children}</span>;
}

function phaseLabel(phase: Phase, sseStatus: string): string {
  switch (phase) {
    case 'idle':
      return '待上传';
    case 'uploading':
      return '上传中';
    case 'creating':
      return '建会话中';
    case 'extracting':
      return `抽取中 (sse=${sseStatus})`;
    case 'reviewing':
      return '审阅中';
    case 'importing':
      return '导入中';
    case 'error':
      return '失败';
  }
}

function formatError(err: unknown): string {
  if (err instanceof ApiAuthError) return err.message;
  if (err instanceof ApiError) return `${err.code ?? 'error'}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

const headStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  marginBottom: 'var(--s-3)',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-h4)',
  fontWeight: 500,
  color: 'var(--ink)',
};

const metaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const dropzoneStyle: React.CSSProperties = {
  width: '100%',
  padding: '32px 24px',
  border: '2px dashed var(--line)',
  borderRadius: 'var(--r-2)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink-3)',
  cursor: 'pointer',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
};

const fileListStyle: React.CSSProperties = {
  margin: 'var(--s-3) 0 0',
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const fileItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-2)',
};

const mutedStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--again-ink)',
};

const blockBoxStyle: React.CSSProperties = {
  marginTop: 'var(--s-4)',
  padding: 'var(--s-3) var(--s-4)',
  background: 'var(--paper)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
};

const blockHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  marginBottom: 'var(--s-2)',
  flexWrap: 'wrap',
};

const blockIndexStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  fontWeight: 500,
  color: 'var(--ink-3)',
};

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
  display: 'block',
  marginTop: 'var(--s-3)',
  marginBottom: 'var(--s-2)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
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
  padding: '6px 10px',
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
  gap: 4,
  marginTop: 'var(--s-2)',
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '4px 10px',
  borderRadius: 'var(--r-pill)',
  border: `1px solid ${active ? 'var(--coral)' : 'var(--line)'}`,
  background: active ? 'var(--coral-soft)' : 'var(--paper-sunk)',
  color: active ? 'var(--coral-ink)' : 'var(--ink-2)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: 'var(--ls-wide)',
});

const timelineStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 'var(--s-2) 0 0',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const timelineItemStyle: React.CSSProperties = {
  padding: '4px 0',
  borderBottom: '1px dotted var(--line-soft)',
};

const timelineCodeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-2)',
};
