import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface KnowledgeNode {
  id: string;
  name: string;
  parent_id: string | null;
  archived_at: number | null;
  effective_domain: string | null;
}

interface PageSpan {
  page_index: number;
  bbox: { x: number; y: number; width: number; height: number };
  role?: 'prompt' | 'answer_area' | 'continuation';
}

interface IngestionBlock {
  block_id: string;
  source_block_ids: string[];
  page_spans: PageSpan[];
  image_refs: string[];
  extracted_prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string | null;
  visual_complexity: 'low' | 'medium' | 'high';
  extraction_confidence: number;
  knowledge_hint: string | null;
}

interface IngestionSession {
  id: string;
  source_document_id: string | null;
  status: string;
  source_asset_ids: string[];
  entrypoint: 'vision_single' | 'vision_paper';
  created_at: number;
  updated_at: number;
}

interface EditableCard {
  localId: string;
  block_id?: string;
  source_block_ids: string[];
  page_spans: PageSpan[];
  image_refs: string[];
  visual_complexity: 'low' | 'medium' | 'high';
  extraction_confidence: number;
  knowledge_hint: string | null;
  final_prompt_md: string;
  final_reference_md: string;
  final_wrong_answer_md: string;
  knowledge_ids: string[];
  cause_category: string;
  cause_notes: string;
  difficulty: number;
  question_kind: string;
  selected: boolean;
}

const QUESTION_KINDS = ['short_answer', 'choice', 'true_false', 'fill_blank', 'essay', 'computation', 'reading', 'translation'];
const CAUSE_CATEGORIES = ['concept', 'knowledge_gap', 'calculation', 'reading', 'memory', 'expression', 'method', 'carelessness', 'time_pressure', 'other'];

async function uploadAsset(file: File): Promise<{ id: string; mime_type: string; byte_size: number; name: string }> {
  const form = new FormData();
  form.set('file', file);
  const res = await fetch('/api/assets', {
    method: 'POST',
    headers: { 'x-internal-token': INTERNAL_TOKEN },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /api/assets ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { asset: { id: string; mime_type: string; byte_size: number } };
  return { id: body.asset.id, mime_type: body.asset.mime_type, byte_size: body.asset.byte_size, name: file.name };
}

async function fetchKnowledge(): Promise<KnowledgeNode[]> {
  const res = await fetch('/api/knowledge', { headers: { 'x-internal-token': INTERNAL_TOKEN } });
  if (!res.ok) throw new Error(`GET /api/knowledge ${res.status}`);
  const body = (await res.json()) as { rows: KnowledgeNode[] };
  return body.rows;
}

function blockToCard(b: IngestionBlock): EditableCard {
  return {
    localId: crypto.randomUUID(),
    block_id: b.block_id,
    source_block_ids: b.source_block_ids,
    page_spans: b.page_spans,
    image_refs: b.image_refs,
    visual_complexity: b.visual_complexity,
    extraction_confidence: b.extraction_confidence,
    knowledge_hint: b.knowledge_hint,
    final_prompt_md: b.extracted_prompt_md,
    final_reference_md: b.reference_md ?? '',
    final_wrong_answer_md: b.wrong_answer_md ?? '',
    knowledge_ids: [],
    cause_category: '',
    cause_notes: '',
    difficulty: 3,
    question_kind: 'short_answer',
    selected: false,
  };
}

export function IngestSession() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'upload' | 'review'>('upload');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<IngestionSession | null>(null);
  const [cards, setCards] = useState<EditableCard[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const knowledgeQuery = useQuery<KnowledgeNode[]>({
    queryKey: ['/api/knowledge'],
    queryFn: fetchKnowledge,
  });

  const knowledgeOptions = useMemo(() => {
    const rows = knowledgeQuery.data ?? [];
    return [...rows].sort((a, b) => {
      const da = a.effective_domain ?? '';
      const db = b.effective_domain ?? '';
      if (da !== db) return da.localeCompare(db);
      return a.name.localeCompare(b.name);
    });
  }, [knowledgeQuery.data]);

  const selectedCount = cards.filter((c) => c.selected).length;

  function updateCard(localId: string, patch: Partial<EditableCard>) {
    setCards((prev) => prev.map((c) => (c.localId === localId ? { ...c, ...patch } : c)));
  }

  function toggleCardKnowledge(localId: string, knId: string) {
    setCards((prev) =>
      prev.map((c) =>
        c.localId === localId
          ? {
              ...c,
              knowledge_ids: c.knowledge_ids.includes(knId)
                ? c.knowledge_ids.filter((x) => x !== knId)
                : [...c.knowledge_ids, knId],
            }
          : c,
      ),
    );
  }

  async function handleExtract() {
    if (selectedFiles.length === 0 || uploading) return;
    setErrorMsg(null);
    setUploading(true);
    const uploadedIds: string[] = [];
    try {
      for (const file of selectedFiles) {
        const asset = await uploadAsset(file);
        uploadedIds.push(asset.id);
      }
    } catch (e) {
      setErrorMsg(`上传失败: ${(e as Error).message}`);
      setUploading(false);
      return;
    }

    try {
      const entrypoint = selectedFiles.length > 1 ? 'vision_paper' : 'vision_single';
      const res = await fetch('/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({ entrypoint, asset_ids: uploadedIds }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`POST /api/ingestion ${res.status}: ${text}`);
      }
      const body = (await res.json()) as { session: IngestionSession; blocks: IngestionBlock[] };
      if (body.session.status === 'failed' || body.blocks.length === 0) {
        setErrorMsg('OCR 失败，请检查图片');
        setUploading(false);
        return;
      }
      const initial = body.blocks.map(blockToCard);
      setSessionId(body.session.id);
      setSession(body.session);
      setCards(initial);
      setPhase('review');
    } catch (e) {
      setErrorMsg(`提取失败: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  function handleMerge() {
    setCards((prev) => {
      const sel = prev.filter((c) => c.selected);
      if (sel.length < 2) return prev;
      const firstSelectedIndex = prev.findIndex((c) => c.selected);
      const merged: EditableCard = {
        localId: crypto.randomUUID(),
        block_id: undefined,
        source_block_ids: sel.flatMap((c) => c.source_block_ids),
        page_spans: sel.flatMap((c) => c.page_spans),
        image_refs: Array.from(new Set(sel.flatMap((c) => c.image_refs))),
        visual_complexity: sel.some((c) => c.visual_complexity === 'high')
          ? 'high'
          : sel.some((c) => c.visual_complexity === 'medium')
          ? 'medium'
          : 'low',
        extraction_confidence: Math.min(...sel.map((c) => c.extraction_confidence)),
        knowledge_hint: sel.map((c) => c.knowledge_hint).filter(Boolean).join('; ') || null,
        final_prompt_md: sel.map((c) => c.final_prompt_md).join('\n\n'),
        final_reference_md: sel
          .map((c) => c.final_reference_md)
          .filter((s) => s.length > 0)
          .join('\n\n'),
        final_wrong_answer_md: sel
          .map((c) => c.final_wrong_answer_md)
          .filter((s) => s.length > 0)
          .join('\n\n'),
        knowledge_ids: Array.from(new Set(sel.flatMap((c) => c.knowledge_ids))),
        cause_category: sel.find((c) => c.cause_category)?.cause_category ?? '',
        cause_notes: sel
          .map((c) => c.cause_notes)
          .filter((s) => s.length > 0)
          .join('; '),
        difficulty: Math.max(...sel.map((c) => c.difficulty)),
        question_kind: sel[0].question_kind,
        selected: false,
      };
      const remaining = prev.filter((c) => !c.selected);
      remaining.splice(firstSelectedIndex, 0, merged);
      return remaining;
    });
  }

  function handleSplit(localId: string) {
    setCards((prev) => {
      const idx = prev.findIndex((c) => c.localId === localId);
      if (idx === -1) return prev;
      const orig = prev[idx];
      const mid = Math.floor(orig.final_prompt_md.length / 2);
      const a: EditableCard = {
        ...orig,
        localId: crypto.randomUUID(),
        block_id: undefined,
        source_block_ids: orig.source_block_ids,
        final_prompt_md: orig.final_prompt_md.slice(0, mid).trim(),
        final_wrong_answer_md: '',
        final_reference_md: '',
        selected: false,
      };
      const b: EditableCard = {
        ...orig,
        localId: crypto.randomUUID(),
        block_id: undefined,
        source_block_ids: orig.source_block_ids,
        final_prompt_md: orig.final_prompt_md.slice(mid).trim(),
        final_wrong_answer_md: '',
        final_reference_md: '',
        selected: false,
      };
      const next = [...prev];
      next.splice(idx, 1, a, b);
      return next;
    });
  }

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      const blocks = cards.map((c) => ({
        block_id: c.block_id,
        source_block_ids: c.source_block_ids,
        page_spans: c.page_spans,
        image_refs: c.image_refs,
        final_prompt_md: c.final_prompt_md,
        final_reference_md: c.final_reference_md.trim() === '' ? null : c.final_reference_md,
        final_wrong_answer_md: c.final_wrong_answer_md,
        knowledge_ids: c.knowledge_ids,
        cause: c.cause_category
          ? {
              primary_category: c.cause_category,
              user_notes: c.cause_notes.trim() === '' ? null : c.cause_notes,
            }
          : null,
        difficulty: c.difficulty,
        question_kind: c.question_kind,
      }));
      const res = await fetch(`/api/ingestion/${sessionId}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({ blocks }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`POST /api/ingestion/${sessionId}/import ${res.status}: ${text}`);
      }
      return (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    },
    onSuccess: () => {
      navigate('/mistakes');
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  function handleImport() {
    setErrorMsg(null);
    const invalid = cards.find(
      (c) =>
        !c.final_prompt_md.trim() ||
        !c.final_wrong_answer_md.trim() ||
        c.knowledge_ids.length === 0,
    );
    if (invalid) {
      setErrorMsg('每题必须有题面、错答、至少一个知识点');
      return;
    }
    importMutation.mutate();
  }

  if (phase === 'upload') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-xl font-semibold mb-4">批量导入错题（视觉提取）</h1>
        <p className="text-sm text-slate-500 mb-6">上传题目截图或扫描件，AI 自动识别题目并拆块。</p>

        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">选择图片（PNG / JPEG / WebP，可多张）</span>
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="mt-1 block text-sm"
              onChange={(e) => {
                setSelectedFiles(Array.from(e.target.files ?? []));
                setErrorMsg(null);
              }}
            />
          </label>

          {selectedFiles.length > 0 && (
            <ul className="space-y-1">
              {selectedFiles.map((f, i) => (
                <li key={i} className="text-xs text-slate-600 border rounded px-2 py-1">
                  {f.name} · {(f.size / 1024).toFixed(0)} KB
                </li>
              ))}
            </ul>
          )}

          {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

          <button
            type="button"
            disabled={selectedFiles.length === 0 || uploading}
            onClick={handleExtract}
            className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {uploading ? '上传 & 提取中...' : '开始提取'}
          </button>
        </div>
      </main>
    );
  }

  // review phase
  const mergedCount = cards.filter((c) => c.source_block_ids.length > 1).length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">
          已识别 {cards.length} 题
          {mergedCount > 0 && `，已合并 ${mergedCount} 组`}
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700">
            {session?.status ?? ''}
          </span>
          <button
            type="button"
            onClick={() => {
              setPhase('upload');
              setSelectedFiles([]);
              setSessionId(null);
              setSession(null);
              setCards([]);
              setErrorMsg(null);
            }}
            className="text-sm underline text-slate-600"
          >
            ← 返回上传
          </button>
        </div>
      </div>

      <div className="sticky top-0 z-10 bg-white border-b py-2 mb-4 flex items-center gap-4">
        <span className="text-sm text-slate-600">已选 {selectedCount} 题</span>
        <button
          type="button"
          disabled={selectedCount < 2}
          onClick={handleMerge}
          className="px-3 py-1 bg-amber-100 text-amber-800 text-sm rounded disabled:opacity-40"
        >
          合并选中
        </button>
      </div>

      {knowledgeQuery.isLoading && (
        <p className="text-sm text-slate-500 mb-2">知识点加载中...</p>
      )}

      <div className="space-y-6">
        {cards.map((card, idx) => (
          <CardView
            key={card.localId}
            card={card}
            idx={idx}
            knowledgeOptions={knowledgeOptions}
            onUpdate={(patch) => updateCard(card.localId, patch)}
            onToggleKnowledge={(knId) => toggleCardKnowledge(card.localId, knId)}
            onSplit={() => handleSplit(card.localId)}
          />
        ))}
      </div>

      {errorMsg && <p className="text-sm text-red-600 mt-4">{errorMsg}</p>}

      <div className="mt-6 pt-4 border-t flex items-center gap-4">
        <button
          type="button"
          disabled={importMutation.isPending || cards.length === 0}
          onClick={handleImport}
          className="bg-slate-900 text-white px-5 py-2 rounded disabled:opacity-50"
        >
          {importMutation.isPending ? '导入中...' : `全部导入 (${cards.length} 题)`}
        </button>
        <span className="text-xs text-slate-500">导入后跳转到错题列表</span>
      </div>
    </main>
  );
}

interface CardViewProps {
  card: EditableCard;
  idx: number;
  knowledgeOptions: KnowledgeNode[];
  onUpdate: (patch: Partial<EditableCard>) => void;
  onToggleKnowledge: (knId: string) => void;
  onSplit: () => void;
}

function CardView({ card, idx, knowledgeOptions, onUpdate, onToggleKnowledge, onSplit }: CardViewProps) {
  const confidenceLow = card.extraction_confidence < 0.5;

  return (
    <div className="border rounded p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={card.selected}
            onChange={(e) => onUpdate({ selected: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-sm font-medium text-slate-700">题 #{idx + 1}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              confidenceLow ? 'bg-yellow-100 text-yellow-800' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {card.visual_complexity} · 置信度 {(card.extraction_confidence * 100).toFixed(0)}%
          </span>
          {card.knowledge_hint && (
            <span className="text-xs text-slate-400 truncate max-w-48" title={card.knowledge_hint}>
              hint: {card.knowledge_hint}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onSplit}
          className="text-xs px-2 py-1 border rounded text-slate-600 hover:bg-slate-50"
        >
          拆分本题
        </button>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-slate-600">题面 *</span>
        <textarea
          value={card.final_prompt_md}
          onChange={(e) => onUpdate({ final_prompt_md: e.target.value })}
          rows={4}
          className="mt-1 w-full border rounded p-2 font-mono text-sm"
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-slate-600">参考答案（可空）</span>
        <textarea
          value={card.final_reference_md}
          onChange={(e) => onUpdate({ final_reference_md: e.target.value })}
          rows={2}
          className="mt-1 w-full border rounded p-2 font-mono text-sm"
          placeholder="参考答案 (可空)"
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-slate-600">错答 *</span>
        <textarea
          value={card.final_wrong_answer_md}
          onChange={(e) => onUpdate({ final_wrong_answer_md: e.target.value })}
          rows={2}
          className="mt-1 w-full border rounded p-2 font-mono text-sm"
          placeholder="错答 (vision 可能填了，编辑后即提交)"
        />
      </label>

      <fieldset className="border rounded p-2">
        <legend className="text-xs font-medium px-1 text-slate-600">知识点 *（多选）</legend>
        <div className="grid grid-cols-2 gap-1 mt-1 max-h-40 overflow-y-auto">
          {knowledgeOptions.map((node) => (
            <label key={node.id} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={card.knowledge_ids.includes(node.id)}
                onChange={() => onToggleKnowledge(node.id)}
              />
              <span>
                {node.name}
                {node.parent_id && <span className="text-slate-400"> ↳</span>}
                <span className="text-slate-400 ml-1">[{node.effective_domain ?? '?'}]</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">题型</span>
          <select
            value={card.question_kind}
            onChange={(e) => onUpdate({ question_kind: e.target.value })}
            className="mt-1 w-full border rounded p-1.5 text-sm"
          >
            {QUESTION_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">难度</span>
          <select
            value={card.difficulty}
            onChange={(e) => onUpdate({ difficulty: Number(e.target.value) })}
            className="mt-1 w-full border rounded p-1.5 text-sm"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-slate-600">错因（可空，留空 → AI 自动归因）</span>
        <select
          value={card.cause_category}
          onChange={(e) => onUpdate({ cause_category: e.target.value })}
          className="mt-1 w-full border rounded p-1.5 text-sm"
        >
          <option value="">— AI 兜底 —</option>
          {CAUSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>

      {card.cause_category && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">备注（可空）</span>
          <input
            value={card.cause_notes}
            onChange={(e) => onUpdate({ cause_notes: e.target.value })}
            className="mt-1 w-full border rounded p-1.5 text-sm"
          />
        </label>
      )}
    </div>
  );
}
