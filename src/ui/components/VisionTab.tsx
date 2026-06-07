'use client';

// Phase 1c.2 Vision — /record vision_single + vision_paper tab body.
//
// 1c.2.B MVP shipped the happy path (upload → SSE → review → import).
// 1c.2.C added (this file):
//   - Per-block image preview via /api/assets/[id]/content (blob URL) with
//     SVG bbox overlay per page_span.
//   - Tier 2 / Tier 3 rescue buttons per block, calling
//     /api/ingestion/[id]/rescue and invalidating the blocks query.
//   - Cross-page block merge: each block past the first can be merged into
//     the previous bucket; followers render as a compact pill, the primary
//     keeps the editor; at import time we concatenate source_block_ids /
//     page_spans / image_refs into one ImportBlock per bucket.
//   - Read-only collapsible preview of the Tencent Mark Agent structured
//     tree (block.structured) — sub_questions / options / answers /
//     question_no — sits above the editable prompt textarea.

import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import { expandPdf, uploadAsset, useAssetUrl } from '@/ui/lib/assets';
import { type AutoEnrollObservation, seedBlockForm } from '@/ui/lib/auto-enroll';
import { causeOptionsForSelectedKnowledge } from '@/ui/lib/cause-options';
import { useIngestionSSE } from '@/ui/lib/sse';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { Icon } from '@/ui/primitives/Icon';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

type Mode = 'vision_single' | 'vision_paper';

type Phase =
  | 'idle'
  | 'expanding'
  | 'uploading'
  | 'creating'
  | 'extracting'
  | 'reviewing'
  | 'importing'
  | 'error';

type QuestionKindId =
  | 'choice'
  | 'true_false'
  | 'fill_blank'
  | 'short_answer'
  | 'essay'
  | 'computation'
  | 'reading'
  | 'translation';

type CauseCategoryId = string;

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

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

interface StructuredNode {
  id: string;
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string;
  prompt_text: string;
  options?: { label: string; text: string }[];
  answers?: string[];
  sub_questions?: StructuredNode[];
}

export interface BlockRow {
  id: string;
  ingestion_session_id: string;
  source_asset_ids: string[];
  page_spans: Array<{
    page_index: number;
    bbox: { x: number; y: number; width: number; height: number };
    role?: string;
  }>;
  extracted_prompt_md: string | null;
  structured: StructuredNode | null;
  reference_md: string | null;
  wrong_answer_md: string | null;
  image_refs: string[];
  layout_quality: 'structured' | 'partial' | 'text_only';
  extraction_confidence: number;
  // 4-state question_block union (business.ts:145). `auto_enrolled` only appears
  // once WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED is ON; observe-only prod stays draft.
  status: 'draft' | 'imported' | 'ignored' | 'auto_enrolled';
  knowledge_hint: string | null;
  // YUK-164 OC-5: per-block AI auto-enroll observation surfaced by the blocks
  // route. Drives the AI prefill (seedBlockForm) + the "AI 预填" badge. `null`
  // when the judge wrote no observation for this block.
  auto_enroll_observation: AutoEnrollObservation | null;
  created_at: number;
}

interface BlockFormState {
  prompt_md: string;
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
  // When the single picked file is a PDF (vision_paper only), it expands
  // server-side to N page images; pdfPageCount is the count returned by
  // /api/ingestion/pdf, used for the "展开 PDF（N 页）" labels.
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blockForms, setBlockForms] = useState<Record<string, BlockFormState>>({});
  // bucketByBlockId[blockId] = primary block id of the merge bucket. Initially
  // every block points at itself. "合并到上一个块" rewrites this to the
  // previous block's bucket. Followers render as a compact pill and their
  // form state is ignored at import time.
  const [bucketByBlockId, setBucketByBlockId] = useState<Record<string, string>>({});
  const seededBlockIdsRef = useRef<Set<string>>(new Set());

  const sse = useIngestionSSE(phase === 'extracting' ? sessionId : null);

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

  const blocksQ = useQuery<{ rows: BlockRow[] }>({
    queryKey: ['ingestion-blocks', sessionId],
    queryFn: () => apiJson<{ rows: BlockRow[] }>(`/api/ingestion/${sessionId}/blocks`),
    enabled: phase === 'reviewing' && sessionId !== null,
  });

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  useEffect(() => {
    const rows = blocksQ.data?.rows ?? [];
    if (rows.length === 0) return;
    setBlockForms((prev) => {
      const next = { ...prev };
      for (const b of rows) {
        if (seededBlockIdsRef.current.has(b.id)) continue;
        seededBlockIdsRef.current.add(b.id);
        // OCR-derived text fields come straight off the block; the AI-prefillable
        // fields (knowledge_ids / cause_primary / cause_notes / question_kind /
        // difficulty) come from seedBlockForm, which maps b.auto_enroll_observation
        // when present and falls back to today's defaults otherwise. knowledge_ids
        // + cause_primary are seeded together so the self-heal effect below
        // (cause_primary ∉ causeOptions → clear) admits a valid seeded cause.
        next[b.id] = {
          ...seedBlockForm(b),
          prompt_md: b.extracted_prompt_md ?? '',
          reference_md: b.reference_md ?? '',
          wrong_answer_md: b.wrong_answer_md ?? '',
          ignored: false,
        };
      }
      return next;
    });
    setBucketByBlockId((prev) => {
      const next = { ...prev };
      for (const b of rows) {
        if (!(b.id in next)) next[b.id] = b.id;
      }
      return next;
    });
  }, [blocksQ.data]);

  const startMutation = useMutation({
    mutationFn: async (selectedFiles: File[]) => {
      let ids: string[];
      // PDF expansion is a vision_paper-only entrypoint: only that mode's accept
      // attr admits application/pdf. Bind the branch to mode explicitly so a
      // future reuse of this mutation under vision_single can't silently route a
      // PDF through expandPdf.
      const pdf = mode === 'vision_paper' && selectedFiles.length === 1 && isPdf(selectedFiles[0]);
      if (pdf) {
        // PDF path: one file → server renders to N page images, returns their
        // asset ids. Reuses the same /api/ingestion + extract flow afterwards.
        setPhase('expanding');
        const expanded = await expandPdf(selectedFiles[0]);
        setPdfPageCount(expanded.page_count);
        ids = expanded.asset_ids;
      } else {
        setPhase('uploading');
        const assets = await Promise.all(selectedFiles.map((f) => uploadAsset(f)));
        ids = assets.map((a) => a.id);
      }
      setPhase('creating');
      const session = await apiJson<{
        session: { id: string };
      }>('/api/ingestion', {
        method: 'POST',
        body: JSON.stringify({ entrypoint: mode, asset_ids: ids }),
      });
      await apiJson(`/api/ingestion/${session.session.id}/extract`, { method: 'POST' });
      return session.session.id;
    },
    onSuccess: (id) => {
      setSessionId(id);
      setPhase('extracting');
    },
    onError: (err) => {
      // Clear any stale page count: if expandPdf succeeded but a later step
      // (session create / extract) failed, pdfPageCount would otherwise linger
      // and flash an outdated "N 页" in the error / retry state.
      setPdfPageCount(null);
      setErrorMessage(formatError(err));
      setPhase('error');
    },
  });

  // groups = primary block + followers in source order. Used by both the
  // reviewing UI (one editor per primary) and the import handler (one
  // ImportBlock per bucket).
  const groups = useMemo(() => {
    const rows = blocksQ.data?.rows ?? [];
    const byPrimary = new Map<string, { primary: BlockRow; followers: BlockRow[] }>();
    for (const b of rows) {
      const bucket = bucketByBlockId[b.id] ?? b.id;
      if (bucket === b.id) {
        const existing = byPrimary.get(b.id);
        if (existing) existing.primary = b;
        else byPrimary.set(b.id, { primary: b, followers: [] });
      } else {
        const cur = byPrimary.get(bucket);
        if (cur) cur.followers.push(b);
        else
          byPrimary.set(bucket, {
            primary: rows.find((r) => r.id === bucket) ?? b,
            followers: [b],
          });
      }
    }
    // Preserve original source order based on the primary's index.
    return rows
      .filter((b) => (bucketByBlockId[b.id] ?? b.id) === b.id)
      .map((b) => byPrimary.get(b.id))
      .filter((g): g is { primary: BlockRow; followers: BlockRow[] } => Boolean(g));
  }, [blocksQ.data, bucketByBlockId]);

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      const importable = groups
        .filter((g) => !blockForms[g.primary.id]?.ignored)
        .map((g) => {
          const f = blockForms[g.primary.id];
          if (!f) throw new Error(`block ${g.primary.id} form missing`);
          if (!f.prompt_md.trim()) throw new Error(`block ${g.primary.id}: 题面不能空`);
          if (!f.wrong_answer_md.trim()) throw new Error(`block ${g.primary.id}: 错答不能空`);
          if (f.knowledge_ids.length === 0)
            throw new Error(`block ${g.primary.id}: 至少选 1 个知识点`);
          const members = [g.primary, ...g.followers];
          const sourceBlockIds = members.map((m) => m.id);
          const pageSpans = members.flatMap((m) => m.page_spans);
          const ensuredSpans =
            pageSpans.length > 0
              ? pageSpans
              : [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }];
          const imageRefs = Array.from(
            new Set(
              members.flatMap((m) => (m.image_refs.length > 0 ? m.image_refs : m.source_asset_ids)),
            ),
          );
          return {
            block_id: g.primary.id,
            source_block_ids: sourceBlockIds,
            page_spans: ensuredSpans,
            image_refs: imageRefs,
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

  const rescueMutation = useMutation({
    mutationFn: async (vars: { block: BlockRow; tier: 2 | 3 }) => {
      if (!sessionId) throw new Error('no session');
      const page = vars.block.page_spans[0]?.page_index ?? 0;
      return apiJson(`/api/ingestion/${sessionId}/rescue`, {
        method: 'POST',
        body: JSON.stringify({
          block_id: vars.block.id,
          page,
          tier: vars.tier,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestion-blocks', sessionId] });
    },
  });

  const onPickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const pdfs = all.filter(isPdf);
    setPdfPageCount(null);
    if (pdfs.length > 0) {
      // PDF is a single-file pick that expands server-side. Reject a mixed
      // PDF + image selection (and multiple PDFs) with a clear inline error.
      if (all.length > 1) {
        setFiles([]);
        setErrorMessage('PDF 请单独上传（不要和图片或其它 PDF 混选）');
        return;
      }
      setFiles([all[0]]);
      setErrorMessage(null);
      return;
    }
    // Image path: the maxFiles cap applies only to the multi-image pick.
    const picked = all.slice(0, maxFiles);
    setFiles(picked);
    setErrorMessage(null);
  };

  const reset = () => {
    setPhase('idle');
    setFiles([]);
    setPdfPageCount(null);
    setSessionId(null);
    setBlockForms({});
    setBucketByBlockId({});
    seededBlockIdsRef.current = new Set();
    setErrorMessage(null);
  };

  const blocks = blocksQ.data?.rows ?? [];
  const rowIndexById = new Map(blocks.map((b, i) => [b.id, i]));

  const mergeIntoPrev = (blockId: string) => {
    const idx = rowIndexById.get(blockId);
    if (idx === undefined || idx === 0) return;
    const prevId = blocks[idx - 1].id;
    const prevBucket = bucketByBlockId[prevId] ?? prevId;
    setBucketByBlockId((cur) => ({ ...cur, [blockId]: prevBucket }));
  };
  const splitMerge = (blockId: string) => {
    setBucketByBlockId((cur) => ({ ...cur, [blockId]: blockId }));
  };

  return (
    <Card pad="lg" className="record-card vision-card">
      <div className="record-card-head">
        <h2>{mode === 'vision_single' ? '单题拍照' : '整页拍照'}</h2>
        <span className="meta">
          {mode === 'vision_single' ? '1 张图' : '1–5 张试卷照'} · {phaseLabel(phase, sse.status)}
        </span>
      </div>

      {(phase === 'idle' || phase === 'error') && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={
              mode === 'vision_paper'
                ? 'image/png,image/jpeg,image/webp,application/pdf'
                : 'image/png,image/jpeg,image/webp'
            }
            multiple={mode === 'vision_paper'}
            style={{ display: 'none' }}
            onChange={(e) => onPickFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="dropzone record-dropzone"
          >
            <Icon name={mode === 'vision_single' ? 'camera' : 'upload'} size={32} />
            {files.length > 0 ? (
              <span className="dropzone-title">
                {isPdf(files[0])
                  ? '已选 1 个 PDF · 点击重选'
                  : `已选 ${files.length} 张 · 点击重选`}
              </span>
            ) : (
              <span className="dropzone-title">
                {mode === 'vision_single' ? '拍一题就好' : '拖照片到此处 · 或点这里上传'}
              </span>
            )}
            <span className="hint">
              {mode === 'vision_single'
                ? '单题直接走 Vision；不经 Tencent Mark Agent'
                : 'JPEG / PNG / WebP · 单次最多 5 页 · 或上传 1 个 PDF（≤15 页）· 抽取进度走 SSE'}
            </span>
          </button>
          {files.length > 0 && (
            <ul className="record-file-list">
              {/* A picked PDF is one row — it expands to N page images
                  server-side, so we don't pre-list N image rows. */}
              {isPdf(files[0]) ? (
                <li key={files[0].name}>
                  <span>
                    {files[0].name} · PDF{pdfPageCount != null ? ` · ${pdfPageCount} 页` : ''}
                  </span>
                  <span className="meta">{(files[0].size / 1024).toFixed(1)} KB</span>
                </li>
              ) : (
                files.map((f) => (
                  <li key={f.name}>
                    <span>{f.name}</span>
                    <span className="meta">{(f.size / 1024).toFixed(1)} KB</span>
                  </li>
                ))
              )}
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

      {(phase === 'expanding' ||
        phase === 'uploading' ||
        phase === 'creating' ||
        phase === 'extracting') && (
        <div>
          <p style={{ ...mutedStyle, marginTop: 0 }}>
            {phase === 'expanding' && '展开 PDF…（渲染每一页为图片）'}
            {phase === 'uploading' && `上传 ${files.length} 张图到 R2 …`}
            {phase === 'creating' &&
              (pdfPageCount != null
                ? `已展开 ${pdfPageCount} 页 · 创建 ingestion session…`
                : '创建 ingestion session…')}
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
          {groups.map((g) => (
            <BlockEditor
              key={g.primary.id}
              primary={g.primary}
              followers={g.followers}
              primaryIndex={rowIndexById.get(g.primary.id) ?? 0}
              canMergeIntoPrev={
                (rowIndexById.get(g.primary.id) ?? 0) > 0 && mode === 'vision_paper'
              }
              form={blockForms[g.primary.id]}
              setForm={(updater) =>
                setBlockForms((prev) => {
                  const cur = prev[g.primary.id];
                  if (!cur) return prev;
                  return { ...prev, [g.primary.id]: updater(cur) };
                })
              }
              knowledgeNodes={knowledgeQ.data?.rows ?? []}
              onMergeIntoPrev={() => mergeIntoPrev(g.primary.id)}
              onSplitMerge={splitMerge}
              onRescue={(block, tier) => rescueMutation.mutate({ block, tier })}
              rescuing={rescueMutation.isPending}
            />
          ))}
          {rescueMutation.isError && (
            <p style={errorStyle}>救援失败：{formatError(rescueMutation.error)}</p>
          )}
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
              disabled={groups.length === 0 || importMutation.isPending}
            >
              {importMutation.isPending
                ? '导入中…'
                : `批量导入 · ${groups.filter((g) => !blockForms[g.primary.id]?.ignored).length} 道 → /mistakes`}
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

// Exported for the static-HTML test (VisionTab.test.tsx) — BlockEditor renders
// the "AI 预填，可改" badge from primary.auto_enroll_observation and is
// renderToString-safe (its useState/useMemo/useEffect only need initial render).
export interface BlockEditorProps {
  primary: BlockRow;
  followers: BlockRow[];
  primaryIndex: number;
  canMergeIntoPrev: boolean;
  form: BlockFormState | undefined;
  setForm: (updater: (cur: BlockFormState) => BlockFormState) => void;
  knowledgeNodes: KnowledgeNode[];
  onMergeIntoPrev: () => void;
  onSplitMerge: (followerId: string) => void;
  onRescue: (block: BlockRow, tier: 2 | 3) => void;
  rescuing: boolean;
}

export function BlockEditor({
  primary,
  followers,
  primaryIndex,
  canMergeIntoPrev,
  form,
  setForm,
  knowledgeNodes,
  onMergeIntoPrev,
  onSplitMerge,
  onRescue,
  rescuing,
}: BlockEditorProps) {
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
  const selectedKnowledgeIds = form?.knowledge_ids;
  const causeOptions = useMemo(
    () => causeOptionsForSelectedKnowledge(knowledgeNodes, selectedKnowledgeIds ?? []),
    [knowledgeNodes, selectedKnowledgeIds],
  );

  useEffect(() => {
    if (!form?.cause_primary) return;
    if (causeOptions.some((option) => option.id === form.cause_primary)) return;
    setForm((cur) => ({ ...cur, cause_primary: '', cause_notes: '' }));
  }, [causeOptions, form?.cause_primary, setForm]);

  if (!form) return null;
  const toggleKid = (id: string) =>
    setForm((cur) => ({
      ...cur,
      knowledge_ids: cur.knowledge_ids.includes(id)
        ? cur.knowledge_ids.filter((x) => x !== id)
        : [...cur.knowledge_ids, id],
    }));

  const members = [primary, ...followers];

  return (
    <div
      style={{
        ...blockBoxStyle,
        opacity: form.ignored ? 0.5 : 1,
      }}
    >
      <div style={blockHeadStyle}>
        <span style={blockIndexStyle}>#{primaryIndex + 1}</span>
        <LayoutQualityBadge q={primary.layout_quality} />
        <Badge tone="neutral">conf {(primary.extraction_confidence * 100).toFixed(0)}%</Badge>
        <span style={metaStyle}>{formatRelTime(new Date(primary.created_at * 1000))}</span>
        {followers.length > 0 && <Badge tone="info">merged · {followers.length + 1} blocks</Badge>}
        {/* YUK-164 OC-5: AI prefill marker. info-blue tone = AI actor (round2a
            §1.3); the literal "AI 预填，可改" text is the non-color cue. Present
            only when the judge produced an observation for this block. */}
        {primary.auto_enroll_observation && (
          <Badge tone="info">
            <Icon name="spark" size={12} />
            AI 预填，可改
          </Badge>
        )}
        <span style={{ flex: 1 }} />
        {canMergeIntoPrev && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onMergeIntoPrev}
            disabled={form.ignored}
            title="把本块作为上一块的延续"
          >
            合并到上块
          </Button>
        )}
        {primary.layout_quality !== 'structured' && (
          <>
            <Button
              variant="hard"
              size="sm"
              onClick={() => onRescue(primary, 2)}
              disabled={form.ignored || rescuing}
              title="haiku rescue"
            >
              {rescuing ? '…' : 'Tier 2'}
            </Button>
            <Button
              variant="coral"
              size="sm"
              onClick={() => onRescue(primary, 3)}
              disabled={form.ignored || rescuing}
              title="sonnet rescue"
            >
              {rescuing ? '…' : 'Tier 3'}
            </Button>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...metaStyle }}>
          <input
            type="checkbox"
            checked={form.ignored}
            onChange={(e) => setForm((cur) => ({ ...cur, ignored: e.target.checked }))}
          />
          忽略本块
        </label>
      </div>

      {/* Image strip — one preview per source asset across all merged members. */}
      <BlockImageStrip members={members} />

      {followers.length > 0 && (
        <div style={mergeStripStyle}>
          {followers.map((f) => (
            <span key={f.id} style={followerPillStyle}>
              <code style={timelineCodeStyle}>{f.id.slice(0, 6)}</code>
              <button
                type="button"
                onClick={() => onSplitMerge(f.id)}
                style={splitBtnStyle}
                title="解除合并"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {primary.structured && (
        <details style={{ marginTop: 'var(--s-3)' }}>
          <summary style={metaStyle}>OCR structured 树（只读，调试）</summary>
          <StructuredOutline node={primary.structured} />
        </details>
      )}

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
        {causeOptions.map((c) => (
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

// One image preview per (assetId, page_index) combination across all merged
// blocks. Each preview overlays the bbox(es) that landed on that page.
function BlockImageStrip({ members }: { members: BlockRow[] }) {
  // Build a unique list of (assetId, page_index) tuples with their bboxes.
  type ImgKey = { assetId: string; page: number; bboxes: BlockRow['page_spans'] };
  const groups = useMemo(() => {
    const out: ImgKey[] = [];
    for (const m of members) {
      const assets = m.image_refs.length > 0 ? m.image_refs : m.source_asset_ids;
      for (const a of assets) {
        for (const span of m.page_spans.length > 0
          ? m.page_spans
          : [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }]) {
          const existing = out.find((e) => e.assetId === a && e.page === span.page_index);
          if (existing) existing.bboxes.push(span);
          else out.push({ assetId: a, page: span.page_index, bboxes: [span] });
        }
      }
    }
    return out;
  }, [members]);

  if (groups.length === 0) return null;
  return (
    <div style={imageStripStyle}>
      {groups.map((g) => (
        <BlockImagePreview key={`${g.assetId}#${g.page}`} assetId={g.assetId} bboxes={g.bboxes} />
      ))}
    </div>
  );
}

function BlockImagePreview({
  assetId,
  bboxes,
}: {
  assetId: string;
  bboxes: BlockRow['page_spans'];
}) {
  const { url, loading, error } = useAssetUrl(assetId);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  if (loading) {
    return <div style={imageThumbLoadingStyle}>加载图…</div>;
  }
  if (error || !url) {
    return <div style={imageThumbErrorStyle}>图加载失败</div>;
  }

  // Bboxes are stored normalized (0..1). SVG viewBox matches that so the
  // overlay scales 1:1 regardless of the rendered image size.
  return (
    <div style={imageThumbWrapStyle}>
      <img
        src={url}
        alt=""
        style={imageThumbStyle}
        onLoad={(e) =>
          setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
      />
      {dims && bboxes.length > 0 && (
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          style={imageOverlayStyle}
          aria-hidden="true"
        >
          {bboxes.map((b, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: bboxes are stable per render of this preview
              key={i}
              x={b.bbox.x}
              y={b.bbox.y}
              width={b.bbox.width}
              height={b.bbox.height}
              fill="rgba(215,119,87,0.18)"
              stroke="var(--coral)"
              strokeWidth={0.004}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
    </div>
  );
}

function StructuredOutline({ node, depth = 0 }: { node: StructuredNode; depth?: number }) {
  const headerBits = [node.role, node.question_no].filter(Boolean).join(' · ');
  return (
    <ul style={{ ...structuredListStyle, marginLeft: depth === 0 ? 0 : 'var(--s-3)' }}>
      <li>
        <span style={structuredHeaderStyle}>{headerBits || node.role}</span>
        <span style={structuredPromptStyle}>{node.prompt_text}</span>
        {node.options && node.options.length > 0 && (
          <ul style={{ ...structuredListStyle, marginTop: 2 }}>
            {node.options.map((o) => (
              <li key={o.label} style={structuredOptionStyle}>
                <code style={timelineCodeStyle}>{o.label}.</code> {o.text}
              </li>
            ))}
          </ul>
        )}
        {node.answers && node.answers.length > 0 && (
          <span style={structuredAnswerStyle}> · answer: {node.answers.join(', ')}</span>
        )}
        {node.sub_questions &&
          node.sub_questions.length > 0 &&
          node.sub_questions.map((s) => (
            <StructuredOutline key={s.id} node={s} depth={depth + 1} />
          ))}
      </li>
    </ul>
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
    <section className="sse-feed">
      <div className="head">
        <h4>抽取进度</h4>
        <span className="conn">
          <span className="dot" />
          SSE · {status}
        </span>
      </div>
      <div className="sse-rows">
        {events.map((e) => (
          <div
            key={e.event_id}
            className={[
              'sse-row',
              e.event_type.includes('failed') ? 'fail' : '',
              e.event_type.includes('completed') || e.event_type.includes('imported')
                ? 'success'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="t">#{e.event_id}</span>
            <span className="msg">
              <code>{e.event_type}</code>
              {e.payload.block_count !== undefined && (
                <span className="meta"> · {String(e.payload.block_count)} blocks</span>
              )}
              {typeof e.payload.layout_quality === 'string' && (
                <span className="meta"> · {e.payload.layout_quality}</span>
              )}
              {typeof e.payload.error_message === 'string' && (
                <span className="record-error"> · {e.payload.error_message}</span>
              )}
            </span>
            <code>{eventShortId(e.event_type)}</code>
          </div>
        ))}
        {events.length === 0 && (
          <div className="sse-row">
            <span className="t">--</span>
            <span className="msg muted">等待事件…</span>
            <code>{status}</code>
          </div>
        )}
      </div>
    </section>
  );
}

function eventShortId(eventType: string): string {
  const parts = eventType.split('.');
  return parts.at(-1) ?? eventType;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span style={fieldLabelStyle}>{children}</span>;
}

function isPdf(file: File): boolean {
  // file.type can be '' for drag-and-drop / some OS file pickers even for a
  // genuine PDF, so fall back to the extension. The server still validates the
  // %PDF magic bytes (pdf-render.ts hasPdfMagic), so a misnamed non-PDF is caught
  // there with a loud 400 — this only widens which files reach that check.
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function phaseLabel(phase: Phase, sseStatus: string): string {
  switch (phase) {
    case 'idle':
      return '待上传';
    case 'expanding':
      return '展开 PDF 中';
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

const metaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
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

const timelineCodeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-2)',
};

const imageStripStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s-2)',
  marginTop: 'var(--s-2)',
};

const imageThumbWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  maxWidth: 220,
  background: 'var(--paper-sunk)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  overflow: 'hidden',
};

const imageThumbStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  height: 'auto',
};

const imageOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
};

const imageThumbLoadingStyle: React.CSSProperties = {
  width: 200,
  height: 80,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--paper-sunk)',
  border: '1px dashed var(--line)',
  borderRadius: 'var(--r-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
};

const imageThumbErrorStyle: React.CSSProperties = {
  ...imageThumbLoadingStyle,
  color: 'var(--again-ink)',
};

const mergeStripStyle: React.CSSProperties = {
  marginTop: 'var(--s-2)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const followerPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 6px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-pill)',
  background: 'var(--paper-sunk)',
};

const splitBtnStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
  cursor: 'pointer',
};

const structuredListStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 'var(--s-2) 0 0',
  padding: 0,
  borderLeft: '2px solid var(--line-soft)',
  paddingLeft: 'var(--s-2)',
};

const structuredHeaderStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
  marginRight: 'var(--s-2)',
};

const structuredPromptStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-2)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const structuredOptionStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-2)',
};

const structuredAnswerStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--good-ink)',
};
