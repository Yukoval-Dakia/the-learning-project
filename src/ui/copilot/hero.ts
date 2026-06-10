// YUK-307 (presentation layer §2.3/§2.5) — pure, React-free hero-nomination
// routing for the Copilot Dock, extracted here so it is unit-testable in the
// node vitest env without jsdom (same precedent as replay.ts; the unit env is
// 'node' and @testing-library is not installed). CopilotHeroCard.tsx imports
// resolveArtifactHero to build the reference card; the rendering + sandbox live
// in the component.
//
// 不重复取数 (§2.3): the resolver maps {kind} → {label, icon, route} from the
// ref ALONE — it never fetches the artifact. The link target opens the
// artifact's own page, which does the real load.

import type { LoomIconName } from '@/ui/primitives/LoomIcon';

export interface ArtifactHero {
  label: string;
  icon: LoomIconName;
  /** The artifact's own page; opening the link loads it (no re-fetch here). */
  href: string;
}

// ref.kind is the agent's FREE-FORM label (registry 指令 lists 题 / 卷 / note /
// interactive; the marker JSON example uses English "question"). Keys are
// lower-cased; Chinese has no case so it round-trips through toLowerCase. Routes
// are grounded in existing test fixtures + UI links, NOT guessed:
//   • note / interactive → /notes/{id}    — generic artifact viewer (D UI page)
//   • question (题)       → /questions/{id} — read-only question detail (id = q_*)
//   • quiz / paper (卷)   → /practice/{id}  — paper artifact (id = art_*; chat.ts
//                            already links 「去练习」→ /practice/art_*)
interface KindRoute {
  label: string;
  icon: LoomIconName;
  path: (id: string) => string;
}
// id is encodeURIComponent'd into the path: the server caps it (z.string().max
// (120)) but does not pin its char-class, so a malformed agent id (whitespace /
// '../' / '?x=1') would otherwise yield a malformed link. Defense-in-depth only
// — the literal '/notes/' etc. prefix already keeps every href same-origin
// (no protocol/host breakout); normal ids (note_*, q_*, art_*) round-trip
// unchanged through encodeURIComponent. (YUK-307 review LOW.)
const KIND_ROUTES: Record<string, KindRoute> = {
  note: { label: '笔记', icon: 'doc', path: (id) => `/notes/${encodeURIComponent(id)}` },
  笔记: { label: '笔记', icon: 'doc', path: (id) => `/notes/${encodeURIComponent(id)}` },
  interactive: {
    label: '互动内容',
    icon: 'sparkle',
    path: (id) => `/notes/${encodeURIComponent(id)}`,
  },
  互动: { label: '互动内容', icon: 'sparkle', path: (id) => `/notes/${encodeURIComponent(id)}` },
  question: { label: '题目', icon: 'quiz', path: (id) => `/questions/${encodeURIComponent(id)}` },
  题: { label: '题目', icon: 'quiz', path: (id) => `/questions/${encodeURIComponent(id)}` },
  题目: { label: '题目', icon: 'quiz', path: (id) => `/questions/${encodeURIComponent(id)}` },
  quiz: { label: '练习', icon: 'layers', path: (id) => `/practice/${encodeURIComponent(id)}` },
  paper: { label: '练习', icon: 'layers', path: (id) => `/practice/${encodeURIComponent(id)}` },
  卷: { label: '练习', icon: 'layers', path: (id) => `/practice/${encodeURIComponent(id)}` },
  试卷: { label: '练习', icon: 'layers', path: (id) => `/practice/${encodeURIComponent(id)}` },
};

/**
 * Resolve an `{source:'artifact'}` nomination's reference card from its ref
 * alone. Returns null for an unrecognised kind — the card then renders link-less
 * (we never route what we can't recognise; the nomination still surfaces).
 */
export function resolveArtifactHero(ref: { kind: string; id: string }): ArtifactHero | null {
  const route = KIND_ROUTES[ref.kind.trim().toLowerCase()];
  if (!route) return null;
  return { label: route.label, icon: route.icon, href: route.path(ref.id) };
}
