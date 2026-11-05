// What the page says about a change and about a refusal. Pure, so the page stays about layout.

import { ApiError } from '@/ui/lib/api';

interface TopicLike {
  key: string;
  name: string;
  facts: ReadonlyArray<{ id: string; body: string }>;
}

export interface TopicDiff {
  key: string;
  name: string;
  kind: 'added' | 'removed' | 'changed';
  added: string[];
  removed: string[];
}

/** What changed between two versions, topic by topic, by fact. */
export function diffTopics(before: readonly TopicLike[], after: readonly TopicLike[]): TopicDiff[] {
  const out: TopicDiff[] = [];
  const beforeByKey = new Map(before.map((topic) => [topic.key, topic]));
  const afterByKey = new Map(after.map((topic) => [topic.key, topic]));
  for (const topic of after) {
    const old = beforeByKey.get(topic.key);
    const oldBodies = new Set(old?.facts.map((fact) => fact.body));
    const newBodies = new Set(topic.facts.map((fact) => fact.body));
    const added = topic.facts.map((fact) => fact.body).filter((body) => !oldBodies.has(body));
    const removed = (old?.facts ?? []).map((fact) => fact.body).filter((b) => !newBodies.has(b));
    if (!old || added.length > 0 || removed.length > 0) {
      out.push({
        key: topic.key,
        name: topic.name,
        kind: old ? 'changed' : 'added',
        added,
        removed,
      });
    }
  }
  for (const topic of before) {
    if (afterByKey.has(topic.key)) continue;
    out.push({
      key: topic.key,
      name: topic.name,
      kind: 'removed',
      added: [],
      removed: topic.facts.map((fact) => fact.body),
    });
  }
  return out;
}

const REFUSALS: Readonly<Record<string, string>> = {
  context_version_conflict: '内容刚变过，已经换成最新的。看一眼再说一次。',
  context_edit_not_committed: '这句没改成，内容还是原来的。可以再说一次。',
  context_undo_depth: '这一步本身就是撤销，不能再撤销了。想改的话，直接说一句。',
  context_undo_conflict: '后面又有改动，这一步撤销不了。想改的话，直接说一句。',
  context_topic_withdrawn: '这个主题已经删掉了，要记回来需要你再说一次。',
};

export function refusalText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && REFUSALS[code]) || '这次没成功，内容没有变。稍后再试。';
}

/** Today by time, otherwise by date. */
export function whenText(at: string, now = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()} 年 `;
  return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
