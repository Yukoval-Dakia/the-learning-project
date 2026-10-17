// YUK-1512 — the redaction receipt on the upload screens: one quiet line saying which
// kinds of personal info were hidden in this upload's recognised text, and,
// for 'answer_only' material, that it is only used for this question. Fed by the
// ingestion session detail (GET /api/ingestion-sessions/:id → usage_receipt, YUK-1408);
// counts only, never the removed text. Renders nothing until the receipt exists.
import { useQuery } from '@tanstack/react-query';
import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

type SessionDetail = ApiOperationJsonResponse<'getIngestionSession'>;
export type UsageReceipt = NonNullable<SessionDetail['usage_receipt']>;

/** Shared query for the session detail, so the receipt and the landing warnings read one cache entry. */
export function ingestionSessionDetailQuery(sessionId: string) {
  return {
    queryKey: ['ingestion-session-detail', sessionId] as const,
    queryFn: (): Promise<SessionDetail> =>
      apiOperationJson('getIngestionSession', {
        url: `/api/ingestion-sessions/${encodeURIComponent(sessionId)}`,
        method: 'GET',
      }),
  };
}

// Category codes from src/capabilities/ingestion/server/privacy-guard.ts (RedactedField).
const FIELD_LABELS: readonly (readonly [code: string, label: string])[] = [
  ['labeled_identity', '姓名/学校/班级等身份信息'],
  ['phone', '电话号码'],
  ['labeled_contact', '微信/QQ/地址等联系方式'],
  ['email', '邮箱'],
  ['id_number', '身份证号/考号等证件号码'],
  ['ranking', '排名'],
  ['credential', '密钥或口令'],
];
const OTHER_LABEL = '其他个人信息';

export function usageReceiptText(receipt: UsageReceipt): string {
  const counts = receipt.redaction_counts;
  const known = new Set(FIELD_LABELS.map(([code]) => code));
  const parts: string[] = [];
  for (const [code, label] of FIELD_LABELS) {
    const n = counts[code] ?? 0;
    if (n > 0) parts.push(`${n} 处${label}`);
  }
  let other = 0;
  for (const [code, n] of Object.entries(counts)) {
    if (!known.has(code) && n > 0) other += n;
  }
  if (other > 0) parts.push(`${other} 处${OTHER_LABEL}`);

  // Scoped to the recognised text: counts come from the text redaction only (page
  // images that reach a model are never altered), and are an upper bound of the
  // spans marked [已隐去], hence 「隐去」 and no stronger claim.
  const redaction =
    parts.length > 0
      ? `从识别出的文字里隐去了 ${parts.join('、')}；原文件本身不会被改动。`
      : '识别出的文字里没有发现需要隐去的个人信息。';
  // YUK-1408 (#1760): photo/PDF recognition sends the page image itself to the model,
  // unaltered; say so plainly. Unknown channels (null) keep the text-only wording.
  const rawImages =
    receipt.channels?.page_images === 'raw'
      ? '原图会原样交给 AI 识别，个人信息只在识别出的文字里隐去。'
      : '';
  const usage = receipt.derivation_policy === 'answer_only' ? '这份资料只用于本题。' : '';
  return `${redaction}${rawImages}${usage}`;
}

export function UsageReceiptLine({
  sessionId,
  enabled = true,
}: {
  sessionId: string | null;
  enabled?: boolean;
}) {
  const detailQ = useQuery({
    ...ingestionSessionDetailQuery(sessionId ?? ''),
    enabled: enabled && sessionId !== null,
  });
  const receipt = detailQ.data?.usage_receipt;
  if (!receipt) return null;
  return <p className="usage-receipt">{usageReceiptText(receipt)}</p>;
}
