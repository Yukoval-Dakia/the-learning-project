// YUK-1548 — UI-only helpers around the stored fence (W1/W2). Parsing itself is the shared
// `parseBlockFence`; this file adds the streaming placeholder fence the chat composer writes into
// draft text while a block is still being drawn. That fence never leaves the browser.

export const BLOCK_DRAFT_FENCE_INFO = 'tlp-block-draft';

export interface BlockDraftView {
  title?: string;
  kind?: string;
  receivedBytes?: number;
  /** The last attempt was refused and the companion is fixing it. */
  retrying?: boolean;
}

export function parseDraftBody(body: string): BlockDraftView {
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    return {
      ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
      ...(typeof raw.kind === 'string' && raw.kind ? { kind: raw.kind } : {}),
      ...(typeof raw.receivedBytes === 'number' ? { receivedBytes: raw.receivedBytes } : {}),
      ...(raw.retrying === true ? { retrying: true } : {}),
    };
  } catch {
    return {};
  }
}

/** A standalone Markdown fence. Bodies are single-line JSON, so they can never close it early. */
export function blockFence(info: string, body: string): string {
  return `\n\n\`\`\`${info}\n${body}\n\`\`\`\n\n`;
}
