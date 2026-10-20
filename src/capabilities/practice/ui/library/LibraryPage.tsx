// YUK-1473 — 题目 (/questions): one library for every question, with four views (全部 / 做错过 /
// 待审核 / 暂不出题). Mistakes and drafts are states of a question, not pages of their own.
// The view and scope live in the address (library-url.ts); data comes from use-library.ts.

import { Segmented, UiNextRoot } from '@/ui-next/public';
import { AllView } from './AllView';
import { HeldView } from './HeldView';
import {
  EMPTY_SCOPE,
  type LibraryScope,
  type LibraryView,
  effectiveScope,
  isScoped,
  readAddress,
  writeAddress,
} from './library-url';
import { MistakesView } from './MistakesView';
import { ReviewView } from './ReviewView';
import { ScopeLine } from './ScopeLine';
import { useLookups, useViewCounts } from './use-library';
import './library.css';
import './library-rows.css';

export interface LibraryPageProps {
  navigate: (to: string) => void;
  /** The current query string (with or without the leading '?'). */
  searchStr: string;
  /** Replace the address without a new history entry (scope changes). */
  replace: (href: string) => void;
}

const VIEW_LEADS: Readonly<Record<LibraryView, string>> = {
  all: '能出给你的题，新收进来的在前。',
  mistakes: '有做错记录的题，最近的在前。这是记录，不代表现在还会错；判分更正过的不算做错。',
  review: '这些题还没启用。核验通过就会开始出给你；也可以打开一道细看再决定。',
  held: '这些题暂时不会出给你。每组写了原因，能处理的在右边直接处理。',
};

function stateSentence(counts: ReturnType<typeof useViewCounts>): string {
  if (counts.all === undefined) return ' ';
  const parts = [`能出给你的题 ${counts.all} 道`];
  if (counts.review) parts.push(`${counts.review} 道等你审核`);
  if (counts.held) parts.push(`${counts.held} 道暂不出题`);
  return `${parts.join('，')}。`;
}

export default function LibraryPage({ navigate, searchStr, replace }: LibraryPageProps) {
  const address = readAddress(searchStr);
  const { view } = address;
  const scope = effectiveScope(view, address.scope);
  const scoped = isScoped(scope);
  const counts = useViewCounts();
  const lookups = useLookups();

  const switchView = (next: LibraryView) =>
    navigate(writeAddress({ ...readAddress(window.location.search), view: next }));
  // Patches land on the address as it is now, so a late search never undoes a picker change.
  const patchScope = (patch: Partial<LibraryScope>) => {
    const current = readAddress(window.location.search);
    if (window.location.pathname !== '/questions') return;
    replace(writeAddress({ view: current.view, scope: { ...current.scope, ...patch } }));
  };
  const clearScope = () => patchScope(EMPTY_SCOPE);
  const common = { scope, scoped, navigate, onClearScope: clearScope };

  return (
    <UiNextRoot className="ql-page">
      <main className="ql-main">
        <header className="ql-head">
          <h1 className="ql-title">题目</h1>
          <p className="ql-sentence">{stateSentence(counts)}</p>
        </header>

        <div className="ql-controls">
          <Segmented
            label="看哪些题"
            value={view}
            onChange={switchView}
            options={[
              { value: 'all', label: '全部', count: counts.all },
              // No count: the mistake read is partial until the backend can filter by it.
              { value: 'mistakes', label: '做错过' },
              { value: 'review', label: '待审核', count: counts.review },
              { value: 'held', label: '暂不出题', count: counts.held },
            ]}
          />
          <ScopeLine view={view} scope={address.scope} lookups={lookups} onPatch={patchScope} />
        </div>

        <section className="ql-body" aria-label={VIEW_LEADS[view]}>
          <p className="ql-lead">{VIEW_LEADS[view]}</p>
          {view === 'all' && <AllView key="all" {...common} />}
          {view === 'mistakes' && <MistakesView key="mistakes" {...common} lookups={lookups} />}
          {view === 'review' && <ReviewView key="review" {...common} />}
          {view === 'held' && <HeldView key="held" {...common} />}
        </section>
      </main>
    </UiNextRoot>
  );
}
