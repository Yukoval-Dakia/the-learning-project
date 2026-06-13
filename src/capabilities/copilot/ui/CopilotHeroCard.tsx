// YUK-307 (presentation layer §2.3/§2.5) — renders the agent's per-reply hero
// nomination (primary_view) below the reply text in the Copilot Dock. This is
// the §2.5 hero carrier UI slice: the agent提名 a single deliverable per turn;
// 缺省=无 hero (this component only mounts when m.primary_view is set).
//
// Three carriers (the primary_view discriminated union):
//   • artifact      → reference card (类型 icon + label + 打开 link). 不重复取数
//                     (§2.3): rendered from the ref ALONE; the destination page
//                     does the real artifact load. Routing in ./hero.
//   • ephemeral_html→ the ref IS the one-shot HTML body — rendered inline through
//                     D's sandboxed iframe (InteractiveArtifactRenderer), whose
//                     null-origin + network-deny CSP security model is inherited
//                     verbatim. §2.4 「持久交互式产物」的一次性孪生.
//   • tool_result   → read-only bespoke view (§2.4 不持久 / §2.5 次要路径). The
//                     Dock renders no tool traces today and 不重复取数 forbids a
//                     re-fetch, so the honest rendering is a named placeholder.
//
// T5 ribbon dosage (§2.5/T5): a hero is the deliverable, not a receipt — this
// card carries NO technical ribbon (cost/model/caused_by). The Dock has no
// tool-trace ribbons at all today, so "suppress on hero" holds by construction.

'use client';

import { getNotePage } from '@/capabilities/notes/ui/notes-api';
import { InteractiveArtifactRenderer } from '@/ui/components/InteractiveArtifactRenderer';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery } from '@tanstack/react-query';
import { type ArtifactHero, isInteractiveArtifactRef, resolveArtifactHero } from './hero';
import type { ReplayPrimaryView } from './replay';

export interface CopilotHeroCardProps {
  primaryView: ReplayPrimaryView;
  /** M5-T3 (YUK-321) — route push injected by CopilotDock (replaces the old link import). */
  navigate: (to: string) => void;
}

// The {source:'artifact'} reference card (§2.3): 类型 icon + label + 打开 link, or
// a link-less kind chip when the kind is unrecognised. Extracted so the
// interactive inline carrier can fall back to it on load/error.
function ArtifactReferenceCard({
  hero,
  fallbackKind,
  navigate,
}: {
  hero: ArtifactHero | null;
  fallbackKind: string;
  navigate: (to: string) => void;
}) {
  if (!hero) {
    return (
      <div className="copilot-hero copilot-hero-ref" data-testid="copilot-hero-artifact">
        <LoomIcon name="doc" size={16} />
        <span className="copilot-hero-label">{fallbackKind}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => navigate(hero.href)}
      className="copilot-hero copilot-hero-ref"
      data-testid="copilot-hero-artifact"
    >
      <LoomIcon name={hero.icon} size={16} />
      <span className="copilot-hero-label">{hero.label}</span>
      <span className="copilot-hero-open">
        打开
        <LoomIcon name="arrow" size={13} />
      </span>
    </button>
  );
}

// ADR-0033 D5 — persistent interactive artifact, inline in the hero (owner chose
// inline over the reference card). Unlike ephemeral_html (the ref IS the body),
// a persistent artifact has only {kind,id}, so this fetches its html via the
// note-page aggregate (reuses L1's `interactive` field — /notes/{id} is the
// artifact's reader shell). Best-effort: while loading, on fetch error, or when
// the row carries no renderable html (parse-fail → interactive=null), it
// degrades to the plain reference card. copilot-hero scale CSS already in
// globals.css (.copilot-loom .copilot-hero .note-interactive-shell).
function InteractiveArtifactHero({
  ref,
  navigate,
}: {
  ref: { kind: string; id: string };
  navigate: (to: string) => void;
}) {
  const noteQ = useQuery({
    queryKey: ['note-page', ref.id],
    queryFn: () => getNotePage(ref.id),
  });
  const html = noteQ.data?.interactive?.html ?? null;
  if (html) {
    return (
      <div className="copilot-hero" data-testid="copilot-hero-interactive">
        <InteractiveArtifactRenderer html={html} title={noteQ.data?.title ?? '互动内容'} />
      </div>
    );
  }
  // loading / error / parse-fail → reference card.
  return (
    <ArtifactReferenceCard
      hero={resolveArtifactHero(ref)}
      fallbackKind={ref.kind}
      navigate={navigate}
    />
  );
}

export function CopilotHeroCard({ primaryView, navigate }: CopilotHeroCardProps) {
  if (primaryView.source === 'ephemeral_html') {
    return (
      <div className="copilot-hero" data-testid="copilot-hero-ephemeral">
        <InteractiveArtifactRenderer html={primaryView.ref} title="互动内容" />
      </div>
    );
  }

  if (primaryView.source === 'artifact') {
    // Persistent interactive artifact → inline render (fetches its own html).
    // Every other artifact kind keeps the reference card (不重复取数, §2.3).
    if (isInteractiveArtifactRef(primaryView.ref.kind)) {
      return <InteractiveArtifactHero ref={primaryView.ref} navigate={navigate} />;
    }
    return (
      <ArtifactReferenceCard
        hero={resolveArtifactHero(primaryView.ref)}
        fallbackKind={primaryView.ref.kind}
        navigate={navigate}
      />
    );
  }

  return (
    <div className="copilot-hero copilot-hero-ref" data-testid="copilot-hero-tool-result">
      <LoomIcon name="eye" size={16} />
      <span className="copilot-hero-label">{primaryView.ref.kind}</span>
    </div>
  );
}
