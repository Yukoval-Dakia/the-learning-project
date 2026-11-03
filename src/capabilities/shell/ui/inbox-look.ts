// Inbox M3E look (YUK-1473): the KIND_META icon names and tones (inbox-api.ts) mapped to lucide
// icons and the ui-next tone roles. Presentation only; KIND_META stays the single vocabulary.
// Design record: docs/design/2026-11-03-inbox-agent-notes-events-m3e.md.

import {
  Archive,
  CircleCheck,
  Clock,
  FileQuestion,
  FileText,
  GitMerge,
  Image,
  Inbox,
  Layers,
  Link2,
  ListChecks,
  type LucideIcon,
  Network,
  Pencil,
  RefreshCw,
  RotateCcw,
  Tag,
  Target,
  Undo2,
} from 'lucide-react';

const KIND_ICON: Record<string, LucideIcon> = {
  knowledge: Network,
  link: Link2,
  refresh: RefreshCw,
  items: ListChecks,
  pencil: Pencil,
  layers: Layers,
  record: FileText,
  checkCircle: CircleCheck,
  review: RotateCcw,
  target: Target,
  merge: GitMerge,
  clock: Clock,
  archive: Archive,
  undo: Undo2,
  image: Image,
  quiz: FileQuestion,
  tag: Tag,
};

/** The lucide icon for a KIND_META icon name; an unknown name gets the inbox tray. */
export function kindIcon(name: string): LucideIcon {
  return KIND_ICON[name] ?? Inbox;
}

/** ui-next tone role for a KIND_META / TIER_META tone (info → accent, coral → secondary). */
export type InboxTone = 'accent' | 'secondary' | 'positive' | 'caution' | 'critical' | 'neutral';

const TONE: Record<string, InboxTone> = {
  info: 'accent',
  coral: 'secondary',
  good: 'positive',
  hard: 'caution',
  again: 'critical',
  neutral: 'neutral',
};

export function inboxTone(tone: string): InboxTone {
  return TONE[tone] ?? 'neutral';
}
