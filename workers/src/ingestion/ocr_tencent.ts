import { buildAuthHeader } from './ocr_tencent_sign';

const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';

export type TencentAction = 'EduPaperOCR' | 'GeneralAccurateOCR';

export interface TencentOCRRegion {
  bbox: { x: number; y: number; width: number; height: number }; // normalized 0–1
  text: string;
  type: 'question' | 'answer' | 'text' | 'figure' | 'unknown';
  confidence: number; // 0–1
  page_index: number;
}

export interface TencentOCRResult {
  regions: TencentOCRRegion[];
  raw_response: unknown;
}

export interface RecognizeOpts {
  action?: TencentAction;
  imageDimensions: { width: number; height: number };
  now?: number; // unix seconds, override for tests
}

interface TencentEnv {
  TENCENT_SECRET_ID: string;
  TENCENT_SECRET_KEY: string;
  TENCENT_OCR_REGION: string;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

interface EduPosition { X: number; Y: number; Width: number; Height: number }
interface EduResultListItem { Question?: { Text: string; Confidence: number } }
interface EduQuestionArrItem { Position: EduPosition; ResultList: EduResultListItem[] }
interface EduQuestionBlockInfo { QuestionArr?: EduQuestionArrItem[] }
interface EduOCRResponse {
  Response?: {
    Error?: { Code: string; Message: string };
    QuestionBlockInfos?: EduQuestionBlockInfo[];
    RequestId?: string;
  };
}

interface GeneralTextItem { DetectedText: string; Confidence: number; ItemPolygon?: { X: number; Y: number; Width: number; Height: number } }
interface GeneralOCRResponse {
  Response?: {
    Error?: { Code: string; Message: string };
    TextDetections?: GeneralTextItem[];
    RequestId?: string;
  };
}

export async function recognizeDocument(
  imageBytes: ArrayBuffer,
  // _mimeType is reserved for a future ImageType header (Tencent accepts 'PNG'|'JPG'|...).
  // Currently unused because ImageBase64 implies the type.
  _mimeType: string,
  pageIndex: number,
  env: TencentEnv,
  opts: RecognizeOpts,
): Promise<TencentOCRResult> {
  const action = opts.action ?? 'EduPaperOCR';
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const imageB64 = arrayBufferToBase64(imageBytes);
  const payloadJson = JSON.stringify({ ImageBase64: imageB64 });

  const auth = await buildAuthHeader({
    secretId: env.TENCENT_SECRET_ID,
    secretKey: env.TENCENT_SECRET_KEY,
    timestamp: now,
    service: SERVICE,
    action,
    payloadJson,
    host: HOST,
  });

  const res = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'host': HOST,
      'authorization': auth,
      'X-TC-Action': action,
      'X-TC-Version': VERSION,
      'X-TC-Region': env.TENCENT_OCR_REGION,
      'X-TC-Timestamp': String(now),
    },
    body: payloadJson,
  });

  if (!res.ok) {
    throw new Error(`Tencent ${action} HTTP ${res.status}`);
  }
  const json = (await res.json()) as EduOCRResponse | GeneralOCRResponse;
  if (json.Response?.Error) {
    throw new Error(
      `Tencent ${action} ${json.Response.Error.Code}: ${json.Response.Error.Message}`,
    );
  }

  const regions =
    action === 'EduPaperOCR'
      ? normalizeEduPaper(json as EduOCRResponse, opts.imageDimensions, pageIndex)
      : normalizeGeneral(json as GeneralOCRResponse, opts.imageDimensions, pageIndex);

  return { regions, raw_response: json };
}

function normalizeEduPaper(
  json: EduOCRResponse,
  dim: { width: number; height: number },
  pageIndex: number,
): TencentOCRRegion[] {
  const out: TencentOCRRegion[] = [];
  const blocks = json.Response?.QuestionBlockInfos ?? [];
  for (const block of blocks) {
    for (const q of block.QuestionArr ?? []) {
      const text = (q.ResultList ?? [])
        .map((r) => r.Question?.Text ?? '')
        .filter((t) => t.length > 0)
        .join('\n');
      const conf =
        (q.ResultList ?? [])
          .map((r) => r.Question?.Confidence ?? 0)
          .reduce((a, b) => a + b, 0) /
        Math.max(1, q.ResultList?.length ?? 0);
      if (!text) continue;
      out.push({
        bbox: {
          x: clamp01(q.Position.X / dim.width),
          y: clamp01(q.Position.Y / dim.height),
          width: clamp01(q.Position.Width / dim.width),
          height: clamp01(q.Position.Height / dim.height),
        },
        text,
        type: 'question',
        confidence: conf / 100, // EduPaperOCR returns 0-100
        page_index: pageIndex,
      });
    }
  }
  return out;
}

function normalizeGeneral(
  json: GeneralOCRResponse,
  dim: { width: number; height: number },
  pageIndex: number,
): TencentOCRRegion[] {
  const out: TencentOCRRegion[] = [];
  for (const t of json.Response?.TextDetections ?? []) {
    const poly = t.ItemPolygon;
    if (!poly) continue;
    out.push({
      bbox: {
        x: clamp01(poly.X / dim.width),
        y: clamp01(poly.Y / dim.height),
        width: clamp01(poly.Width / dim.width),
        height: clamp01(poly.Height / dim.height),
      },
      text: t.DetectedText,
      type: 'text',
      confidence: t.Confidence / 100,
      page_index: pageIndex,
    });
  }
  return out;
}
