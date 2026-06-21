// Onboarding ②a · upload cold-wrap (YUK-473 Slice 2).
// Ported from docs/design/loom-refresh/project/screen-onboarding.jsx (OnboardRecord
// + ObIngest), made real: the prototype mocked ingestion with a setInterval; this
// drives the LIVE upload→extract pipeline (uploadAsset / expandPdf / expandDocx →
// POST /api/ingestion → /extract → useIngestionSSE), styled as the prototype's
// friendly progress rows. Replaces the Slice-1 UploadStubPage at /onboarding/upload.
//
// THIN骨架 (owner 2026-06-21 "Slice 2 收在上传屏接自动入池骨架"): this screen does
// NOT render VisionTab's per-block review editor. Pool insertion is handled by the
// EXISTING auto-enroll tail that fans out off the same OCR job
// (tencent_ocr_extract → boss.send('auto_enroll'), flag WORKFLOW_JUDGE_AUTO_ENROLL_
// ENABLED; dev .env.local ON, prod default OFF). On a true cold tree the auto-enroll
// tail routes blocks to manual review (anti-hallucination drops tags) until the
// cold-start bridge is wired onto the upload path — tracked as YUK-482 (next lane).
// We therefore word the done-state honestly ("N 题已抽出") rather than claiming
// "N active". The banner copy is likewise softened: the prototype's "自动归类学科·
// 挂知识点·补参考答案" + "OCR 默认/VLM 兜底" describe YUK-482's end state + the OCR/
// VLM ordering decision, neither true on this path today.

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { expandDocx, expandPdf, uploadAsset } from '@/ui/lib/assets';
import { latestProgress } from '@/ui/lib/ingestion-phase';
import { useIngestionSSE } from '@/ui/lib/sse';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useEffect, useRef, useState } from 'react';
import { ObSteps } from './ObSteps';
import './onboarding.css';

type Phase = 'idle' | 'expanding' | 'uploading' | 'creating' | 'extracting' | 'done' | 'error';

// vision_paper accept set — mirrors VisionTab (images + PDF + DOCX).
const ACCEPT =
  'image/png,image/jpeg,image/webp,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_FILES = 5;

function isPdf(f: File): boolean {
  return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
}
function isDocx(f: File): boolean {
  return (
    f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    f.name.toLowerCase().endsWith('.docx')
  );
}

type RowState = 'done' | 'run' | 'wait';
interface IngRow {
  label: string;
  state: RowState;
  meta: string;
}

// Map the LIVE SSE signal (latestProgress: OCR done/total + structure stage) onto
// the prototype's three friendly rows. We do NOT show the prototype's 4th row
// (LLM 归类学科·挂知识点·补参考答案) — that's the auto-enroll tail, which has no SSE
// event on THIS stream, so faking a row would over-claim (YUK-482).
function computeRows(
  phase: Phase,
  prog: { done: number; total: number; stage?: string } | null,
  blockCount: number | null,
): IngRow[] {
  const extracting = phase === 'extracting';
  const done = phase === 'done';
  const structure = prog?.stage === 'structure';

  const r1: RowState = done || extracting ? 'done' : 'run';

  let r2: RowState;
  let r2meta: string;
  if (done || structure) {
    r2 = 'done';
    r2meta = prog ? `${prog.total} 页` : '';
  } else if (extracting) {
    r2 = 'run';
    r2meta = prog ? `${prog.done}/${prog.total} 页` : '…';
  } else {
    r2 = 'wait';
    r2meta = '';
  }

  let r3: RowState;
  let r3meta: string;
  if (done) {
    r3 = 'done';
    r3meta = `抽到 ${blockCount ?? 0} 题`;
  } else if (structure) {
    r3 = 'run';
    r3meta = '结构化中…';
  } else {
    r3 = 'wait';
    r3meta = '';
  }

  return [
    { label: '上传原件', state: r1, meta: r1 === 'done' ? '已上传' : '上传中…' },
    { label: 'OCR 逐页识别', state: r2, meta: r2meta },
    { label: '切分题块', state: r3, meta: r3meta },
  ];
}

// Dropzone label — extracted from a nested ternary (OCR #551: nested ternaries banned).
function dropzoneTitle(files: File[]): string {
  if (files.length === 0) return '拖照片到此处 · 或点这里上传';
  const f0 = files[0];
  if (isPdf(f0)) return '已选 1 个 PDF · 点击重选';
  if (isDocx(f0)) return '已选 1 个 DOCX · 点击重选';
  return `已选 ${files.length} 张 · 点击重选`;
}

export interface OnboardRecordProps {
  navigate: (to: string) => void;
}

export default function OnboardRecord({ navigate }: OnboardRecordProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // OCR review (#551): synchronous re-entrancy lock (state is async → a rapid
  // double-click could fire two uploads before the button hides) + a mounted flag
  // so the multi-await `start` chain never setState after an unmount (e.g. the user
  // hits 跳过 mid-flight).
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [blockCount, setBlockCount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Hold the SSE stream open through 'done' as well as 'extracting'. Passing the
  // SAME sessionId across the extracting→done flip means useIngestionSSE's inner
  // effect (dep: [sessionId]) does NOT re-run, so the replayed `events` survive
  // into the done render. Gating on 'extracting' only would flip the arg to null
  // on completion → setEvents([]) → the done-state "OCR 逐页识别" row would lose
  // its "N 页" page-count meta (review finding 1). The stream is already closed
  // server-side post-completion, so this just preserves the last events.
  const sse = useIngestionSSE(phase === 'extracting' || phase === 'done' ? sessionId : null);

  // Terminal SSE → done / error.
  useEffect(() => {
    if (phase !== 'extracting') return;
    for (const e of sse.events) {
      if (e.event_type === 'ingestion.extraction_failed') {
        setErrorMsg(
          typeof e.payload.error_message === 'string' ? e.payload.error_message : '抽题失败',
        );
        setPhase('error');
        return;
      }
      if (e.event_type === 'ingestion.extraction_completed') {
        setBlockCount(typeof e.payload.block_count === 'number' ? e.payload.block_count : 0);
        setPhase('done');
        return;
      }
    }
  }, [phase, sse.events]);

  // OCR #551: flip the mounted flag on unmount so `start`'s post-await setState calls
  // (after expand/upload/create) are skipped if the user navigated away mid-flight.
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const prog = latestProgress(sse.events);
  const done = phase === 'done';
  const inFlight =
    phase === 'expanding' ||
    phase === 'uploading' ||
    phase === 'creating' ||
    phase === 'extracting';

  // Forward the goal id (threaded via ?goal from Welcome) into placement so the probe
  // can scope to the goal's KCs (Slice 3 reads it from the query).
  const goalParam = new URLSearchParams(window.location.search).get('goal');
  const placementTo = goalParam ? `/placement?goal=${encodeURIComponent(goalParam)}` : '/placement';

  const onPick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    setErrorMsg(null);
    // PDF / DOCX are single-file server-side expansions; reject mixed selections.
    if (all.some(isPdf)) {
      if (all.length > 1) {
        setFiles([]);
        setErrorMsg('PDF 请单独上传（不要和图片或其它文件混选）');
        return;
      }
      setFiles([all[0]]);
      return;
    }
    if (all.some(isDocx)) {
      if (all.length > 1) {
        setFiles([]);
        setErrorMsg('DOCX 请单独上传（不要和图片或其它文件混选）');
        return;
      }
      setFiles([all[0]]);
      return;
    }
    setFiles(all.slice(0, MAX_FILES));
  };

  const start = async () => {
    // OCR #551: synchronous re-entrancy lock — a rapid double-click would otherwise
    // fire two uploads before the idle button hides (state is async).
    if (files.length === 0 || inFlightRef.current) return;
    inFlightRef.current = true;
    setErrorMsg(null);
    try {
      const f0 = files[0];
      // DOCX: self-contained endpoint builds the session server-side; go straight
      // to extracting (no separate /api/ingestion + /extract).
      if (files.length === 1 && isDocx(f0)) {
        setPhase('expanding');
        const ingested = await expandDocx(f0);
        if (!mountedRef.current) return;
        setSessionId(ingested.session_id);
        setPhase('extracting');
        return;
      }
      let assetIds: string[];
      if (files.length === 1 && isPdf(f0)) {
        setPhase('expanding');
        const expanded = await expandPdf(f0);
        if (!mountedRef.current) return;
        assetIds = expanded.asset_ids;
      } else {
        setPhase('uploading');
        const assets = await Promise.all(files.map((f) => uploadAsset(f)));
        if (!mountedRef.current) return;
        assetIds = assets.map((a) => a.id);
      }
      setPhase('creating');
      const session = await apiJson<{ session: { id: string } }>('/api/ingestion', {
        method: 'POST',
        body: JSON.stringify({ entrypoint: 'vision_paper', asset_ids: assetIds }),
      });
      await apiJson(`/api/ingestion/${session.session.id}/extract`, { method: 'POST' });
      if (!mountedRef.current) return;
      setSessionId(session.session.id);
      setPhase('extracting');
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(
        e instanceof ApiAuthError ? e.message : e instanceof Error ? e.message : String(e),
      );
      setPhase('error');
    } finally {
      inFlightRef.current = false;
    }
  };

  const reset = () => {
    setFiles([]);
    setPhase('idle');
    setSessionId(null);
    setBlockCount(null);
    setErrorMsg(null);
  };

  const rows = computeRows(phase, prog, blockCount);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div className="eyebrow">RECORD · onboarding · 为你建题库</div>
        <ObSteps active="source" />
        <div className="page-head-row">
          <h1 className="page-title serif">上传你的材料</h1>
          <Btn variant="ghost" icon="arrowL" onClick={() => navigate('/welcome')}>
            返回设定
          </Btn>
        </div>
      </div>

      <div className="ob-wrap-banner ob-rise">
        <div className="ob-wrap-ic">
          <LoomIcon name="sparkle" size={16} />
        </div>
        <div>
          <div className="ob-wrap-t">
            这一步是在<b>为你建题库</b>。
          </div>
          <div className="ob-wrap-s">
            上传后，AI
            会自动抽题、切分，送进你的题库；之后就能拿去做定位练习——你只要上传，剩下交给抽题管道。
          </div>
        </div>
      </div>

      {phase === 'idle' && (
        <LoomCard pad className="ob-rise">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => onPick(e.target.files)}
          />
          <button
            type="button"
            className="dropzone record-dropzone"
            onClick={() => fileInputRef.current?.click()}
          >
            <LoomIcon name="image" size={32} />
            <span className="dropzone-title">{dropzoneTitle(files)}</span>
            <span className="hint">
              JPEG / PNG / WebP · 单次最多 5 页 · 或 1 个 PDF / DOCX · 抽题进度走 SSE
            </span>
          </button>
          {files.length > 0 && (
            <ul className="record-file-list">
              {files.map((f) => (
                <li key={`${f.name}-${f.size}-${f.lastModified}`}>
                  <span>{f.name}</span>
                  <span className="meta">{(f.size / 1024).toFixed(1)} KB</span>
                </li>
              ))}
            </ul>
          )}
          {errorMsg && (
            <div className="ob-inline-err">
              <LoomIcon name="alert" size={14} />
              {errorMsg}
            </div>
          )}
          <div style={{ marginTop: 'var(--s-3)', display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="primary" icon="image" onClick={start} disabled={files.length === 0}>
              上传 + 开始抽题
            </Btn>
          </div>
        </LoomCard>
      )}

      {(inFlight || done) && (
        <LoomCard pad className="ob-rise">
          <div className="ob-ingest">
            {rows.map((r) => (
              <div key={r.label} className={`ob-ing-row${r.state === 'done' ? ' is-done' : ''}`}>
                <span className={`ob-ing-dot is-${r.state}`}>
                  {r.state === 'done' ? (
                    <LoomIcon name="check" size={13} />
                  ) : r.state === 'run' ? (
                    <LoomIcon name="refresh" size={13} />
                  ) : (
                    <span className="ob-ing-pip" />
                  )}
                </span>
                <span className="ob-ing-l">{r.label}</span>
                {r.meta && <span className="ob-ing-meta">{r.meta}</span>}
              </div>
            ))}
          </div>
          <div className="ob-ing-sse">
            <span className="dot" />
            {done
              ? `event=ingestion.done · 抽到 ${blockCount ?? 0} 题`
              : 'SSE · GET /api/ingestion/[id]/events · 抽题进度逐条推送'}
          </div>
        </LoomCard>
      )}

      {phase === 'error' && (
        <LoomCard pad className="ob-rise">
          <div className="ob-inline-err">
            <LoomIcon name="alert" size={14} />
            {errorMsg ?? '抽题失败'}
          </div>
          <div style={{ marginTop: 'var(--s-3)', display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="ghost" icon="arrowL" onClick={reset}>
              重新上传
            </Btn>
          </div>
        </LoomCard>
      )}

      {(inFlight || done) && (
        <div className="ob-exitbar ob-rise">
          <div className="ob-exitbar-fig">{done ? (blockCount ?? 0) : '—'}</div>
          <div className="ob-exitbar-txt">
            {done ? (
              <>
                <b>{blockCount ?? 0} 题已抽出</b> · 送进题库了，可以拿它们做定位。
              </>
            ) : (
              '抽题完成后，这里会亮起「去做定位练习」。'
            )}
          </div>
          <div className="hero-cta">
            {!done && (
              <Btn variant="ghost" onClick={() => navigate('/today')}>
                跳过 · 返回今日
              </Btn>
            )}
            <Btn
              variant="primary"
              iconEnd="arrow"
              disabled={!done}
              onClick={() => navigate(placementTo)}
            >
              去做定位练习
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
