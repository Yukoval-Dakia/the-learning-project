import type { Db, Tx } from '@/db/client';
import { readMemoryBriefNote } from './memory-brief';
import { readTopics } from './topics';
import type { SteadySection } from './types';

type DbLike = Db | Tx;

/** 无 Dreaming 固化记录时 Δ 段的回看窗（companion 渲染按天如实标注）。 */
export const DELTA_FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 画像在启动段里的字符上限。整条主题优先；装不下时按事实边界收尾，绝不让一个
 * 主题把画像整段顶出预算。超出部分指向 query_context。
 *
 * 上限按启动段预算反推：1000 估计 token ≈ 620 个汉字，画像占其中约三分之一
 * （200 汉字 ≈ 320 token），其余留给目标、Δ、掌握度和沟通偏好。420 字符
 * （≈670 token）会单独吃掉大半预算，画像在完整装配时仍会被整段裁掉。
 */
const PORTRAIT_MAX_CHARS = 200;

const PORTRAIT_MORE_SUFFIX = '（更多见 query_context）';

type PortraitTopic = {
  readonly name: string;
  readonly facts: readonly { readonly body: string }[];
};

function topicLine(topic: PortraitTopic): string {
  return `${topic.name}：${topic.facts.map((f) => f.body).join('；')}`;
}

/**
 * Render the portrait by whole topics, keeping the head when the full text does
 * not fit. A truncated portrait says where the rest is; an untruncated one adds
 * no pointer, so the model does not chase context that is already present.
 * The result never exceeds `maxChars`: an over-long single topic is cut at a
 * fact boundary instead of silently pushing the whole portrait out of the
 * startup budget.
 */
export function renderPortrait(
  topics: readonly PortraitTopic[],
  maxChars: number = PORTRAIT_MAX_CHARS,
): string | null {
  const whole: string[] = [];
  for (const topic of topics) {
    const next = [...whole, topicLine(topic)];
    if (next.join('\n').length > maxChars) break;
    whole.push(topicLine(topic));
  }
  if (whole.length === topics.length && whole.length > 0) return whole.join('\n');

  // 有主题没装下：保留已装下的整条主题（从尾部删到「带省略说明」也放得下），
  // 一个整条都放不下时退到首条的事实边界。
  const suffixLen = PORTRAIT_MORE_SUFFIX.length + 1; // '\n' + suffix
  let kept = whole;
  while (kept.length > 0 && `${kept.join('\n')}\n${PORTRAIT_MORE_SUFFIX}`.length > maxChars) {
    kept = kept.slice(0, -1);
  }
  if (kept.length > 0) return `${kept.join('\n')}\n${PORTRAIT_MORE_SUFFIX}`;

  const first = topics[0];
  if (!first) return null;
  const room = maxChars - suffixLen;
  if (room <= 0) return PORTRAIT_MORE_SUFFIX.slice(0, Math.max(0, maxChars));
  let head = '';
  for (const fact of first.facts) {
    const next = head ? `${head}；${fact.body}` : fact.body;
    if (`${first.name}：${next}…`.length > room) break;
    head = next;
  }
  // 主题名本身就可能比可用空间长：此时按字符硬收尾，仍保证总量不超上限。
  const text = `${first.name}：${head ? `${head}…` : '…'}`.slice(0, room);
  return `${text}\n${PORTRAIT_MORE_SUFFIX}`;
}

/**
 * Same per-unit cap for the legacy (pre-digest) brief text, which has no topic
 * structure: cut at a sentence boundary and point at query_context, so the
 * fallback portrait cannot eat the startup budget either.
 */
export function clampPortraitText(
  text: string | null,
  maxChars: number = PORTRAIT_MAX_CHARS,
): string | null {
  if (!text) return null;
  if (text.length <= maxChars) return text;
  const room = maxChars - PORTRAIT_MORE_SUFFIX.length - 1; // '\n' + suffix
  if (room <= 0) return PORTRAIT_MORE_SUFFIX.slice(0, Math.max(0, maxChars));
  const cut = text.slice(0, room);
  const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'), cut.lastIndexOf('；'));
  const head = boundary > 0 ? cut.slice(0, boundary + 1) : `${cut.slice(0, room - 1)}…`;
  return `${head}\n${PORTRAIT_MORE_SUFFIX}`;
}

export async function readSteadySection(db: DbLike, opts: { now: Date }): Promise<SteadySection> {
  const { digest, version } = await readTopics(db);
  const legacy = version === 0 ? (await readMemoryBriefNote(db, 'global')).note : null;
  const dreamingAt = digest.as_of ? new Date(digest.as_of) : null;
  const portrait = renderPortrait(digest.topics.filter((t) => t.key !== 'communication'));
  const legacyPortrait =
    legacy?.recent_week_md ?? legacy?.long_term_md ?? legacy?.recent_months_md ?? null;
  return {
    portraitMd: portrait || clampPortraitText(legacyPortrait),
    asOf: dreamingAt ?? new Date(opts.now.getTime() - DELTA_FALLBACK_LOOKBACK_MS),
    asOfBasis: dreamingAt ? 'dreaming' : 'lookback',
    communicationMd:
      digest.topics
        .find((t) => t.key === 'communication')
        ?.facts.map((f) => f.body)
        .join('；') ?? null,
    overnightMd: digest.overnight,
  };
}
