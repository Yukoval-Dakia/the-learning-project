// NoteReader 作者/版本 actor 派生（YUK-203 P5 / redraw slice 1）。
//
// 后端 NotePage 没有顶层 author —— "谁写的" 只能从 history[].by(AgentRef) 派生
// （见 docs/design/2026-06-03-redraw-slice1-preflight.md §4 缺口 1）。本 helper
// 把 history 折叠成 NoteReader 右栏 Context 需要的形状：一行 author（取最新一条
// history 的 by）+ 一条版本 timeline。history 空 → author 为 null（调用方省略 作者 行）。
//
// 纯 TS，零 React、零 IO。actorLabel 是给 UI 直接渲染的人读字符串，actorIcon 是
// loom icon name（由 LoomIcon 组件解析，本 helper 不渲染图标）。

import type { ArtifactHistoryEntryT } from '@/core/schema/business';

// AgentRef.by enum（'ai' | 'user' | 'system'）+ prototype 用过的 actor 字符串
// （'agent' / 'cron'）→ loom icon name。default('user') 兜底未知 actor。
// 逐字对齐 redraw slice 1 pre-flight 指定的映射：
//   user→'user'、ai/agent→'sparkle'、system/cron→'moon'、default→'user'。
export const ACTOR_ICON: Record<string, string> = {
  user: 'user',
  ai: 'sparkle',
  agent: 'sparkle',
  system: 'moon',
  cron: 'moon',
};

const DEFAULT_ACTOR_ICON = 'user';

// AgentRef.by enum + prototype actor 字符串 → 人读 label。AgentRef 只有
// 'ai' | 'user' | 'system' 三态；prototype 另有 'agent' / 'cron'，一并支持以
// 兼容 history catchall 里可能出现的 actor 字符串。
const ACTOR_LABEL: Record<string, string> = {
  user: '你',
  ai: 'AI',
  agent: 'AI',
  system: '系统',
  cron: '定时任务',
};

function actorIconFor(actor: string | undefined): string {
  if (!actor) return DEFAULT_ACTOR_ICON;
  return ACTOR_ICON[actor] ?? DEFAULT_ACTOR_ICON;
}

function actorLabelFor(actor: string | undefined): string {
  if (!actor) return ACTOR_LABEL.system;
  return ACTOR_LABEL[actor] ?? actor;
}

// 从一条 history entry 取 actor 字符串：优先 AgentRef.by，其次 catchall 里
// 可能塞的 `actor`（prototype 形状）。两者都没有 → undefined（走兜底）。
function actorOf(entry: ArtifactHistoryEntryT | undefined): string | undefined {
  if (!entry) return undefined;
  if (entry.by?.by) return entry.by.by;
  const loose = entry as Record<string, unknown>;
  if (typeof loose.actor === 'string') return loose.actor;
  return undefined;
}

export interface NoteAuthor {
  label: string;
  icon: string;
}

export interface NoteVersionRow {
  version: number;
  // ISO 字符串（history[].at 经 schema coerce 为 Date，这里转回 ISO 交给 UI
  // 的 formatRelTime 渲染，本 helper 不做时间格式化）。
  at: string;
  actorLabel: string;
  actorIcon: string;
  // history[].summary_md（可选）—— 该版本的变更说明。
  note?: string;
}

export interface NoteActorView {
  // 最新一条 history 的 by 派生的作者；history 空 → null（调用方省略 作者 行）。
  author: NoteAuthor | null;
  // 版本 timeline，按 history 原序（后端已是写入顺序）。
  versions: NoteVersionRow[];
}

/**
 * 从 NotePage.history 派生 NoteReader 右栏需要的 作者 + 版本 timeline。
 *
 * - author：取**最新**一条 history entry（数组末位）的 by。history 空 → null。
 * - versions：每条 history entry → 一行 {version, at(ISO), actorLabel, actorIcon, note?}。
 *
 * @param history NotePage.history（ArtifactHistoryEntry[]，by?: AgentRef）。
 */
export function deriveNoteActorView(history: ArtifactHistoryEntryT[] | undefined): NoteActorView {
  const entries = history ?? [];

  const versions: NoteVersionRow[] = entries.map((entry) => {
    const actor = actorOf(entry);
    const row: NoteVersionRow = {
      version: entry.version,
      at: entry.at instanceof Date ? entry.at.toISOString() : new Date(entry.at).toISOString(),
      actorLabel: actorLabelFor(actor),
      actorIcon: actorIconFor(actor),
    };
    if (entry.summary_md) row.note = entry.summary_md;
    return row;
  });

  // 最新一条 = 数组末位（后端按写入顺序 append）。
  const latest = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const author: NoteAuthor | null =
    latest === undefined
      ? null
      : {
          label: actorLabelFor(actorOf(latest)),
          icon: actorIconFor(actorOf(latest)),
        };

  return { author, versions };
}
