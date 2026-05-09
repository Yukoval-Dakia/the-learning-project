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

const MAX_IMAGE_BYTES = 700_000;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
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
  const [promptImages, setPromptImages] = useState<string[]>([]);
  const [wrongAnswerImages, setWrongAnswerImages] = useState<string[]>([]);
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
      navigate('/knowledge/proposals');
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
      prompt_image_refs: promptImages,
      wrong_answer_image_refs: wrongAnswerImages,
    };
    submitMutation.mutate(payload);
  }

  function toggleKnowledge(id: string) {
    setSelectedKnowledgeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function appendImages(
    files: FileList | null,
    setter: (updater: (prev: string[]) => string[]) => void,
  ) {
    if (!files || files.length === 0) return;
    const oversized: string[] = [];
    const dataUrls: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_IMAGE_BYTES) {
        oversized.push(`${file.name} (${(file.size / 1024).toFixed(0)}KB)`);
        continue;
      }
      try {
        dataUrls.push(await readFileAsDataUrl(file));
      } catch (e) {
        setErrorMsg(`读取图片失败: ${(e as Error).message}`);
      }
    }
    if (oversized.length > 0) {
      setErrorMsg(`图片超过 ${MAX_IMAGE_BYTES / 1000}KB 单张上限（D1 cell ~1MB）：${oversized.join(', ')}`);
    }
    if (dataUrls.length > 0) {
      setter((prev) => [...prev, ...dataUrls]);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-4">录入错题</h1>
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
            disabled={submitMutation.isPending}
            className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {submitMutation.isPending ? '提交中...' : '提交'}
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
  images: string[];
  onAdd: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}

function ImagePicker({ label, images, onAdd, onRemove }: ImagePickerProps) {
  return (
    <div className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1 flex flex-wrap gap-2 items-start">
        {images.map((src, i) => (
          <div key={`${i}-${src.slice(0, 32)}`} className="relative">
            <img
              src={src}
              alt={`${label} ${i + 1}`}
              className="h-20 w-20 object-cover border rounded"
            />
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="absolute -top-1 -right-1 bg-red-600 text-white text-xs rounded-full w-5 h-5 leading-5 text-center"
              aria-label="remove"
            >
              ×
            </button>
          </div>
        ))}
        <label className="border-2 border-dashed border-slate-300 rounded h-20 w-20 flex items-center justify-center cursor-pointer text-slate-500 text-xs hover:border-slate-500">
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
