import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface KnowledgeNode {
  id: string;
  name: string;
  parent_id: string | null;
  archived_at: number | null;
  effective_domain: string | null;
}

interface MistakePayload {
  prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: { primary_category: string; user_notes: string | null } | null;
  difficulty: number;
  question_kind: string;
  prompt_image_refs: string[];
  wrong_answer_image_refs: string[];
}

interface UploadedAsset {
  id: string;
  name: string;
  mime_type: string;
  byte_size: number;
}

async function uploadAsset(file: File): Promise<UploadedAsset> {
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
  return { id: body.asset.id, name: file.name, mime_type: body.asset.mime_type, byte_size: body.asset.byte_size };
}

const QUESTION_KINDS = [
  'short_answer',
  'choice',
  'true_false',
  'fill_blank',
  'essay',
  'computation',
  'reading',
  'translation',
];

const CAUSE_CATEGORIES = [
  'concept',
  'knowledge_gap',
  'calculation',
  'reading',
  'memory',
  'expression',
  'method',
  'carelessness',
  'time_pressure',
  'other',
];

async function fetchKnowledge(): Promise<KnowledgeNode[]> {
  const res = await fetch('/api/knowledge', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`GET /api/knowledge failed: ${res.status}`);
  const body = (await res.json()) as { rows: KnowledgeNode[] };
  return body.rows;
}

async function postMistake(payload: MistakePayload): Promise<{ question_id: string; mistake_id: string }> {
  const res = await fetch('/api/mistakes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /api/mistakes failed: ${res.status} ${text}`);
  }
  return (await res.json()) as { question_id: string; mistake_id: string };
}

export function RecordMistake() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const knowledgeQuery = useQuery({ queryKey: ['/api/knowledge'], queryFn: fetchKnowledge });

  const [promptMd, setPromptMd] = useState('');
  const [referenceMd, setReferenceMd] = useState('');
  const [wrongAnswerMd, setWrongAnswerMd] = useState('');
  const [questionKind, setQuestionKind] = useState('short_answer');
  const [difficulty, setDifficulty] = useState(3);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [causeCategory, setCauseCategory] = useState<string>('');
  const [userNotes, setUserNotes] = useState('');
  const [promptImages, setPromptImages] = useState<UploadedAsset[]>([]);
  const [wrongAnswerImages, setWrongAnswerImages] = useState<UploadedAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const knowledgeOptions = useMemo(() => {
    const rows = knowledgeQuery.data ?? [];
    return [...rows].sort((a, b) => {
      const da = a.effective_domain ?? '';
      const db = b.effective_domain ?? '';
      if (da !== db) return da.localeCompare(db);
      return a.name.localeCompare(b.name);
    });
  }, [knowledgeQuery.data]);

  const submitMutation = useMutation({
    mutationFn: postMistake,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/knowledge/proposals'] });
      navigate('/mistakes');
    },
    onError: (err: Error) => {
      setErrorMsg(err.message);
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!promptMd.trim() || !wrongAnswerMd.trim() || selectedKnowledgeIds.length === 0) {
      setErrorMsg('题面、错答、知识点不能为空');
      return;
    }
    const payload: MistakePayload = {
      prompt_md: promptMd,
      reference_md: referenceMd.trim() === '' ? null : referenceMd,
      wrong_answer_md: wrongAnswerMd,
      knowledge_ids: selectedKnowledgeIds,
      cause: causeCategory
        ? { primary_category: causeCategory, user_notes: userNotes.trim() === '' ? null : userNotes }
        : null,
      difficulty,
      question_kind: questionKind,
      prompt_image_refs: promptImages.map((a) => a.id),
      wrong_answer_image_refs: wrongAnswerImages.map((a) => a.id),
    };
    submitMutation.mutate(payload);
  }

  function toggleKnowledge(id: string) {
    setSelectedKnowledgeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function appendImages(
    files: FileList | null,
    setter: (updater: (prev: UploadedAsset[]) => UploadedAsset[]) => void,
  ) {
    if (!files || files.length === 0) return;
    setErrorMsg(null);
    setUploading(true);
    const list = Array.from(files);
    let succeeded = 0;
    try {
      for (const file of list) {
        const asset = await uploadAsset(file);
        // Commit incrementally so a later failure doesn't drop earlier successes.
        setter((prev) => [...prev, asset]);
        succeeded += 1;
      }
    } catch (e) {
      const remaining = list.length - succeeded;
      setErrorMsg(
        `上传图片失败 (${remaining}/${list.length} 张未上传): ${(e as Error).message}`,
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-4">录入错题</h1>
      <p className="text-sm text-slate-500 mb-2">
        拍试卷或多张图? 试 <a href="/ingest" className="underline">/ingest</a>（vision OCR 切块再审核）。
      </p>
      <p className="text-sm text-slate-500 mb-6">
        录完跳转到 <a href="/knowledge/proposals" className="underline">/knowledge/proposals</a> 看 AI 提议。
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">题面 *</span>
          <textarea
            value={promptMd}
            onChange={(e) => setPromptMd(e.target.value)}
            rows={4}
            className="mt-1 w-full border rounded p-2 font-mono text-sm"
            placeholder='"之"在主谓之间的用法是？'
          />
        </label>

        <ImagePicker
          label="题面图（可空）"
          images={promptImages}
          onAdd={(files) => appendImages(files, setPromptImages)}
          onRemove={(i) => setPromptImages((prev) => prev.filter((_, idx) => idx !== i))}
        />

        <label className="block">
          <span className="text-sm font-medium">参考答案（可空）</span>
          <textarea
            value={referenceMd}
            onChange={(e) => setReferenceMd(e.target.value)}
            rows={3}
            className="mt-1 w-full border rounded p-2 font-mono text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">错答 *</span>
          <textarea
            value={wrongAnswerMd}
            onChange={(e) => setWrongAnswerMd(e.target.value)}
            rows={3}
            className="mt-1 w-full border rounded p-2 font-mono text-sm"
          />
        </label>

        <ImagePicker
          label="错答图（可空）"
          images={wrongAnswerImages}
          onAdd={(files) => appendImages(files, setWrongAnswerImages)}
          onRemove={(i) => setWrongAnswerImages((prev) => prev.filter((_, idx) => idx !== i))}
        />

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">题型</span>
            <select
              value={questionKind}
              onChange={(e) => setQuestionKind(e.target.value)}
              className="mt-1 w-full border rounded p-2 text-sm"
            >
              {QUESTION_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">难度</span>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(Number(e.target.value))}
              className="mt-1 w-full border rounded p-2 text-sm"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="border rounded p-3">
          <legend className="text-sm font-medium px-1">知识点 *（多选）</legend>
          {knowledgeQuery.isLoading && <p className="text-sm text-slate-500">加载中...</p>}
          {knowledgeQuery.isError && (
            <p className="text-sm text-red-600">加载失败: {String(knowledgeQuery.error)}</p>
          )}
          {knowledgeOptions.length === 0 && !knowledgeQuery.isLoading && (
            <p className="text-sm text-slate-500">
              tree 为空 — 先 POST /api/_/seed 建 7 个种子节点。
            </p>
          )}
          <div className="grid grid-cols-2 gap-1 mt-2">
            {knowledgeOptions.map((node) => (
              <label key={node.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedKnowledgeIds.includes(node.id)}
                  onChange={() => toggleKnowledge(node.id)}
                />
                <span>
                  {node.name}
                  {node.parent_id && <span className="text-slate-400"> ↳</span>}
                  <span className="text-slate-400 text-xs ml-1">[{node.effective_domain ?? '?'}]</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="text-sm font-medium">错因（可空，留空 → Sub 3 由 AI 自动归因）</span>
          <select
            value={causeCategory}
            onChange={(e) => setCauseCategory(e.target.value)}
            className="mt-1 w-full border rounded p-2 text-sm"
          >
            <option value="">— 留空，AI 兜底（Sub 3）—</option>
            {CAUSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        {causeCategory && (
          <label className="block">
            <span className="text-sm font-medium">备注（可空）</span>
            <input
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              className="mt-1 w-full border rounded p-2 text-sm"
            />
          </label>
        )}

        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={submitMutation.isPending || uploading}
            className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {uploading ? '图片上传中...' : submitMutation.isPending ? '提交中...' : '提交'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPromptMd('');
              setReferenceMd('');
              setWrongAnswerMd('');
              setSelectedKnowledgeIds([]);
              setCauseCategory('');
              setUserNotes('');
              setPromptImages([]);
              setWrongAnswerImages([]);
              setErrorMsg(null);
            }}
            className="border px-4 py-2 rounded"
          >
            清空
          </button>
        </div>
      </form>
    </main>
  );
}

interface ImagePickerProps {
  label: string;
  images: UploadedAsset[];
  onAdd: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}

function ImagePicker({ label, images, onAdd, onRemove }: ImagePickerProps) {
  return (
    <div className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1">
        {images.length > 0 && (
          <ul className="mt-2 space-y-1">
            {images.map((img, i) => (
              <li key={img.id} className="flex items-center justify-between text-xs border rounded px-2 py-1 gap-2">
                <span className="truncate">{img.name} · {(img.byte_size / 1024).toFixed(0)}KB</span>
                <button type="button" className="text-red-600 underline" onClick={() => onRemove(i)}>移除</button>
              </li>
            ))}
          </ul>
        )}
        <label className="mt-2 inline-flex border-2 border-dashed border-slate-300 rounded px-3 py-1 items-center cursor-pointer text-slate-500 text-xs hover:border-slate-500">
          + 加图
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              onAdd(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
