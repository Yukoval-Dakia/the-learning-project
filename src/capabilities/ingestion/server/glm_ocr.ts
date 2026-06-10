import { PermanentError, RetryableError } from '@/core/schema/structured_question';

/**
 * GLM-OCR layout_parsing client — YUK-253 OCR engine swap.
 *
 * Replaces the Tencent QuestionMarkAgent OCR provider with Zhipu GLM-OCR's
 * `layout_parsing` endpoint as the default character-level text OCR + layout
 * source. The layered semantics are unchanged (ADR-0002 / YUK-145 OC-1/OC-2):
 * GLM is the demoted text-hint + figure-bbox layer; the VLM `StructureTask`
 * still owns the structure tree, with a fallback to the OCR structure on VLM
 * outage. This module is the GLM analogue of `tencent_mark.ts`.
 *
 * Endpoint + auth (locked domain fact, YUK-253 issue):
 *   POST https://open.bigmodel.cn/api/paas/v4/layout_parsing
 *   Authorization: Bearer $ZHIPU_API_KEY
 *   body: { model: 'glm-ocr', file: 'data:image/png;base64,<...>' }
 *   JSON ONLY — multipart → content-type unsupported; bare base64 → error 1214.
 *   GLM layout_parsing is synchronous (single request, no submit+poll loop).
 *
 * Tests never hit the live API — `fetch` is mocked (see glm_ocr.test.ts).
 */

const GLM_LAYOUT_PARSING_URL = 'https://open.bigmodel.cn/api/paas/v4/layout_parsing';
const GLM_MODEL = 'glm-ocr';
const DEFAULT_TIMEOUT_MS = 120_000;

/** One layout block GLM returns per page (markdown text or figure region). */
export type GlmLayoutBlock = {
  index: number;
  /** Coarse block class — 'text' | 'image' | … */
  label: string;
  /** Fine block class — 'doc_title' | 'paragraph_title' | 'header_image' | 'image' | … */
  native_label: string;
  /** ABSOLUTE px [x1,y1,x2,y2] (top-left → bottom-right). */
  bbox_2d: [number, number, number, number];
  /**
   * Markdown content (with $...$ LaTeX, GLM uses \frac). VERIFIED against the
   * real fixtures (math-page1 idx 0/9 + yuwen 8 image blocks): image-label
   * blocks OMIT this key entirely (absent, NOT ''). Only text blocks carry it.
   * MUST stay optional — every read site MUST guard for undefined
   * (`typeof content === 'string'` / `content?.trim()`), never `content.xxx`.
   */
  content?: string;
  /** Page px width (redundant with data_info.pages[i].width). */
  width: number;
  /** Page px height (redundant with data_info.pages[i].height). */
  height: number;
};

export type GlmLayoutResponse = {
  id: string;
  request_id: string;
  data_info: { num_pages: number; pages: Array<{ height: number; width: number }> };
  /** OUTER index = page, inner = blocks for that page. */
  layout_details: GlmLayoutBlock[][];
  /** Concatenated page markdown (advisory; blocks are the structured source). */
  md_results: string;
  /** Billable: 0.2 元/百万 tokens (input = output price). */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

export type GlmOcrParams = {
  /** Raw page bytes as base64 (no `data:` prefix); the client builds the data URI. */
  imageBase64: string;
  /** e.g. 'image/png' / 'image/jpeg' — drives the `data:` prefix. */
  mediaType: string;
  /** Optional caller-supplied cancel (composed with the internal timeout). */
  signal?: AbortSignal;
  /** Override the default 120s one-shot timeout (mainly for tests). */
  timeoutMs?: number;
};

/** Minimal shape of a GLM JSON error body (`{ error: { code, message } }`). */
type GlmErrorBody = {
  error?: { code?: string | number; message?: string };
  code?: string | number;
  message?: string;
};

function readGlmErrorCode(body: GlmErrorBody | null): string {
  const raw = body?.error?.code ?? body?.code ?? '';
  return String(raw);
}

function readGlmErrorMessage(body: GlmErrorBody | null): string {
  return body?.error?.message ?? body?.message ?? '';
}

function validateGlmLayoutResponse(parsed: GlmLayoutResponse): void {
  if (!Array.isArray(parsed.layout_details)) {
    throw new PermanentError('GLM returned no layout_details');
  }
  for (const [pageIndex, blocks] of parsed.layout_details.entries()) {
    if (!Array.isArray(blocks)) {
      throw new PermanentError(`GLM layout_details[${pageIndex}] is not an array`);
    }
    for (const [blockIndex, block] of blocks.entries()) {
      if (typeof block.label !== 'string') {
        throw new PermanentError(
          `GLM block [page ${pageIndex} idx ${blockIndex}] missing string label`,
        );
      }
      if (
        !Array.isArray(block.bbox_2d) ||
        block.bbox_2d.length !== 4 ||
        !block.bbox_2d.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new PermanentError(
          `GLM block [page ${pageIndex} idx ${blockIndex}] has invalid bbox_2d`,
        );
      }
    }
  }
}

/**
 * Normalize a GLM failure into the typed Retryable/Permanent errors the handler
 * already classifies (so `markFailedAndLogCost` keeps working unchanged — it
 * accepts any thrown Retryable|Permanent directly).
 *
 * - HTTP 401/403 or missing key → Permanent (auth/arrears never self-heal).
 * - GLM code 1214 (格式错误 / bad data URI) → Permanent.
 * - HTTP 429 / 5xx / network / abort-timeout → Retryable (pg-boss retries).
 */
function mapGlmHttpError(
  status: number,
  body: GlmErrorBody | null,
): RetryableError | PermanentError {
  const code = readGlmErrorCode(body);
  const message = `GLM OCR error [http ${status}${code ? ` code ${code}` : ''}]: ${
    readGlmErrorMessage(body) || 'no message'
  }`;
  if (code === '1214') {
    return new PermanentError(message);
  }
  if (status === 401 || status === 403) {
    return new PermanentError(message);
  }
  if (status === 429 || status >= 500) {
    return new RetryableError(message);
  }
  // Other 4xx (bad request not covered above) → Permanent (won't self-heal).
  return new PermanentError(message);
}

/** Submit one page to GLM layout_parsing and return the parsed JSON. */
export async function runGlmLayoutParsing(params: GlmOcrParams): Promise<GlmLayoutResponse> {
  // Credential fail-fast, mirroring createOcrClient() in tencent_mark.ts. Throw a
  // clear, actionable Permanent error before any fetch so a misconfigured deploy
  // fails loud (not an opaque 401 deep inside the request).
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    throw new PermanentError('GLM OCR client requires ZHIPU_API_KEY');
  }

  // data URI assembly (JSON body only — multipart + bare base64 are rejected).
  const file = `data:${params.mediaType};base64,${params.imageBase64}`;

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Compose the caller's signal with the internal timeout.
  const onCallerAbort = () => controller.abort();
  if (params.signal) {
    if (params.signal.aborted) controller.abort();
    else params.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let resp: Response;
  try {
    resp = await fetch(GLM_LAYOUT_PARSING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: GLM_MODEL, file }),
      signal: controller.signal,
    });
  } catch (err) {
    // Abort (timeout / caller cancel) and network errors → Retryable so pg-boss
    // retries (parity with the Tencent poll-timeout RetryableError).
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RetryableError(`GLM OCR request aborted/timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw new RetryableError(`GLM OCR network error: ${String(err)}`, { cause: err });
  } finally {
    clearTimeout(timer);
    if (params.signal) params.signal.removeEventListener('abort', onCallerAbort);
  }

  if (!resp.ok) {
    let body: GlmErrorBody | null = null;
    try {
      body = (await resp.json()) as GlmErrorBody;
    } catch {
      body = null;
    }
    throw mapGlmHttpError(resp.status, body);
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    throw new PermanentError('GLM OCR returned a non-JSON 2xx body', { cause: err });
  }

  // 2xx but a GLM error code can still surface in the body (some gateways do
  // this). Treat a present error.code the same as an HTTP error.
  const maybeErr = json as GlmErrorBody;
  const inlineCode = readGlmErrorCode(maybeErr);
  if (inlineCode && inlineCode !== '0') {
    throw mapGlmHttpError(200, maybeErr);
  }

  const parsed = json as GlmLayoutResponse;
  validateGlmLayoutResponse(parsed);
  return parsed;
}
