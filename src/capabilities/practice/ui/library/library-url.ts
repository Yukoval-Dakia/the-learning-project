// YUK-1473 — the 题目 library's address. Everything the learner chooses (view and scope) lives
// in the query string so refresh, back and shared links keep it. The sidebar's filter links are
// `?view=mistakes` and `?status=draft`; this module is the only place that knows the keys.

export type LibraryView = 'all' | 'mistakes' | 'review' | 'held';

export interface LibraryScope {
  subject: string | null;
  knowledgeId: string | null;
  kind: string | null;
  source: string | null;
  search: string;
}

export interface LibraryAddress {
  view: LibraryView;
  scope: LibraryScope;
}

export type ScopeField = Exclude<keyof LibraryScope, 'search'>;

const SCOPE_KEYS: Readonly<Record<keyof LibraryScope, string>> = {
  subject: 'subject',
  knowledgeId: 'kc',
  kind: 'kind',
  source: 'source',
  search: 'q',
};

export function readAddress(searchStr: string): LibraryAddress {
  const sp = new URLSearchParams(searchStr);
  const status = sp.get('status');
  const view: LibraryView =
    sp.get('view') === 'mistakes'
      ? 'mistakes'
      : status === 'draft'
        ? 'review'
        : status === 'held'
          ? 'held'
          : 'all';
  const read = (key: string) => sp.get(key)?.trim() || null;
  return {
    view,
    scope: {
      subject: read(SCOPE_KEYS.subject),
      knowledgeId: read(SCOPE_KEYS.knowledgeId),
      kind: read(SCOPE_KEYS.kind),
      source: read(SCOPE_KEYS.source),
      search: read(SCOPE_KEYS.search) ?? '',
    },
  };
}

export function writeAddress({ view, scope }: LibraryAddress): string {
  const sp = new URLSearchParams();
  if (view === 'mistakes') sp.set('view', 'mistakes');
  if (view === 'review') sp.set('status', 'draft');
  if (view === 'held') sp.set('status', 'held');
  for (const field of Object.keys(SCOPE_KEYS) as (keyof LibraryScope)[]) {
    const value = scope[field];
    if (value) sp.set(SCOPE_KEYS[field], value);
  }
  const query = sp.toString();
  return `/questions${query ? `?${query}` : ''}`;
}

/** Which scope conditions a view can honour; the rest are hidden, never silently ignored. */
export const VIEW_SCOPE: Readonly<Record<LibraryView, readonly ScopeField[]>> = {
  all: ['subject', 'knowledgeId', 'kind', 'source'],
  held: ['subject', 'knowledgeId', 'kind', 'source'],
  // /api/review/drafts filters by kind and source; knowledge is matched on the loaded rows.
  review: ['kind', 'source', 'knowledgeId'],
  // /api/mistakes filters by subject; knowledge is matched on the loaded rows.
  mistakes: ['subject', 'knowledgeId'],
};

/** The scope a view actually applies (conditions it cannot honour are dropped). */
export function effectiveScope(view: LibraryView, scope: LibraryScope): LibraryScope {
  const allowed = VIEW_SCOPE[view];
  return {
    subject: allowed.includes('subject') ? scope.subject : null,
    knowledgeId: allowed.includes('knowledgeId') ? scope.knowledgeId : null,
    kind: allowed.includes('kind') ? scope.kind : null,
    source: allowed.includes('source') ? scope.source : null,
    search: scope.search,
  };
}

export function isScoped(scope: LibraryScope): boolean {
  return Boolean(scope.subject || scope.knowledgeId || scope.kind || scope.source || scope.search);
}

export const EMPTY_SCOPE: LibraryScope = {
  subject: null,
  knowledgeId: null,
  kind: null,
  source: null,
  search: '',
};
