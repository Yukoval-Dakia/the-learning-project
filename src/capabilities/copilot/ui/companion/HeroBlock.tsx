// The one deliverable a reply nominated (present_primary_view), under the reply text:
//   • artifact       → a card that opens the artifact's own page (no re-fetch here); an interactive
//                      artifact renders inline in the sandboxed frame once its page loads, and falls
//                      back to the card while loading, on error or without html;
//   • ephemeral_html → the one-shot html, inline in the same sandbox;
//   • tool_result    → the saved result, read-only.

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FileText, Layers, ListChecks, Sparkles } from 'lucide-react';
import type { NotePageClient } from '@/capabilities/notes/ui-public';
import { InteractiveArtifactRenderer } from '@/ui/components/InteractiveArtifactRenderer';
import { queryKeys } from '@/ui/lib/write-invalidation';
import {
  type ArtifactHero,
  type ArtifactHeroIcon,
  isInteractiveArtifactRef,
  resolveArtifactHero,
} from '../hero';
import type { ReplayPrimaryView } from '../replay';
import { ToolResultSnapshot } from './ToolResultSnapshot';

const ICONS: Record<ArtifactHeroIcon, typeof FileText> = {
  note: FileText,
  interactive: Sparkles,
  question: ListChecks,
  practice: Layers,
};

function ArtifactCard({
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
      <div className="un-cp-card un-cp-hero-ref">
        <FileText size={16} aria-hidden="true" />
        <span className="un-cp-hero-label">{fallbackKind}</span>
      </div>
    );
  }
  const Icon = ICONS[hero.icon];
  return (
    <button
      type="button"
      className="un-cp-card un-cp-hero-ref un-cp-hero-link"
      onClick={() => navigate(hero.href)}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="un-cp-hero-label">{hero.label}</span>
      <span className="un-cp-hero-open">
        打开
        <ArrowRight size={14} aria-hidden="true" />
      </span>
    </button>
  );
}

function InteractiveArtifact({
  artifactRef,
  navigate,
  readNotePage,
}: {
  artifactRef: { kind: string; id: string };
  navigate: (to: string) => void;
  readNotePage: NotePageClient;
}) {
  const page = useQuery({
    queryKey: queryKeys.notePage(artifactRef.id),
    queryFn: () => readNotePage(artifactRef.id),
  });
  const html = page.data?.interactive?.html ?? null;
  if (html) {
    return (
      <div className="un-cp-hero-frame">
        <InteractiveArtifactRenderer html={html} title={page.data?.title ?? '互动内容'} />
      </div>
    );
  }
  return (
    <ArtifactCard
      hero={resolveArtifactHero(artifactRef)}
      fallbackKind={artifactRef.kind}
      navigate={navigate}
    />
  );
}

export function HeroBlock({
  view,
  navigate,
  readNotePage,
}: {
  view: ReplayPrimaryView;
  navigate: (to: string) => void;
  /** Notes' reader, supplied by the route host; Copilot does not import Notes values. */
  readNotePage: NotePageClient;
}) {
  if (view.source === 'ephemeral_html') {
    return (
      <div className="un-cp-hero-frame">
        <InteractiveArtifactRenderer html={view.ref} title="互动内容" />
      </div>
    );
  }
  if (view.source === 'artifact') {
    if (isInteractiveArtifactRef(view.ref.kind)) {
      return (
        <InteractiveArtifact
          artifactRef={view.ref}
          navigate={navigate}
          readNotePage={readNotePage}
        />
      );
    }
    return (
      <ArtifactCard
        hero={resolveArtifactHero(view.ref)}
        fallbackKind={view.ref.kind}
        navigate={navigate}
      />
    );
  }
  return <ToolResultSnapshot toolName={view.ref.kind} snapshot={view.snapshot} />;
}
