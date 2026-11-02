// The sheet's title words (YUK-1473): the server's title, else a question's opening words.

import { promptOf } from './block-text';
import type { Recording } from './recording-model';

const TITLE_MAX = 20;
const NO_TEXT_TITLE = '没认出题目文字';

/** The opening words of a question as a title: markup and line breaks dropped, about 20 characters. */
function shortTitle(text: string | null | undefined): string | null {
  const plain = (text ?? '')
    .replace(/[#*_`>$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  const chars = Array.from(plain);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : plain;
}

/**
 * The sheet's title after the time: the server's title when it has one, else the first question's
 * frozen opening words. Null while unknown — an unreadable record never reads as "no text".
 */
export function recordingTitle(rec: Recording, serverTitle: string | null): string | null {
  if (serverTitle) return serverTitle;
  const byNo = [...rec.items].sort(
    (a, b) => (Number.parseInt(a.no ?? '', 10) || 0) - (Number.parseInt(b.no ?? '', 10) || 0),
  );
  const text =
    shortTitle(byNo.find((i) => i.preview)?.preview) ??
    shortTitle(rec.blocks[0] ? promptOf(rec.blocks[0]) : null);
  if (text) return text;
  const known = rec.read === 'history' && rec.gaps.length === 0;
  return known && rec.phase === 'finished' && (rec.items.length > 0 || rec.blocks.length > 0)
    ? NO_TEXT_TITLE
    : null;
}
