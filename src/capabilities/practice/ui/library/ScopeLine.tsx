import { Search, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { KIND_CHOICES, SOURCE_CHOICES } from './library-copy';
import {
  EMPTY_SCOPE,
  type LibraryScope,
  type LibraryView,
  type ScopeField,
  VIEW_SCOPE,
  isScoped,
} from './library-url';
import type { LibraryLookups } from './use-library';

const SEARCH_DELAY_MS = 300;

const FIELD_WORDS: Readonly<Record<ScopeField, { label: string; any: string }>> = {
  subject: { label: '科目', any: '全部科目' },
  knowledgeId: { label: '知识点', any: '全部知识点' },
  kind: { label: '题型', any: '全部题型' },
  source: { label: '来源', any: '全部来源' },
};

/**
 * Search plus the scope as a sentence of inline pickers. Only the conditions the current view can
 * honour are shown. Typing waits a moment before it changes the address.
 */
export function ScopeLine({
  view,
  scope,
  lookups,
  onPatch,
}: {
  view: LibraryView;
  scope: LibraryScope;
  lookups: LibraryLookups;
  /** Apply a change on top of the address as it is when the change lands. */
  onPatch: (patch: Partial<LibraryScope>) => void;
}) {
  // The box follows the address: when the address's search changes from outside (back/forward,
  // clear), the box takes it; while typing, the box keeps what was typed until the address
  // catches up.
  const [draft, setDraft] = useState(scope.search);
  const [seen, setSeen] = useState(scope.search);
  const timer = useRef<number | null>(null);
  if (scope.search !== seen) {
    setSeen(scope.search);
    if (scope.search !== draft.trim()) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setDraft(scope.search);
    }
  }

  // Cancel a pending search when the box leaves (e.g. the learner opened a question).
  const attachSearch = useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const options: Record<ScopeField, ReadonlyArray<{ id: string; label: string }>> = {
    subject: lookups.subjectOptions,
    knowledgeId: lookups.knowledgeOptions.map((k) => ({ id: k.id, label: k.label })),
    kind: KIND_CHOICES,
    source: SOURCE_CHOICES,
  };
  const fields = VIEW_SCOPE[view];

  const typed = (value: string) => {
    setDraft(value);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onPatch({ search: value.trim() });
    }, SEARCH_DELAY_MS);
  };

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setDraft('');
    onPatch(EMPTY_SCOPE);
  };

  return (
    <div className="ql-scope">
      <label className="ql-search">
        <Search aria-hidden="true" className="ql-search-icon" />
        <span className="un-sr-only">搜索题目</span>
        <input
          ref={attachSearch}
          type="search"
          className="ql-search-input"
          placeholder="搜题目里的字"
          value={draft}
          onChange={(event) => typed(event.currentTarget.value)}
        />
      </label>
      <p className="ql-pickers">
        {fields.map((field) => {
          const value = scope[field];
          const words = FIELD_WORDS[field];
          const known = options[field].some((o) => o.id === value);
          return (
            <label key={field} className="ql-picker" data-set={value ? 'true' : 'false'}>
              <span className="ql-picker-label">{words.label}</span>
              <select
                className="ql-picker-select un-hit"
                value={value ?? ''}
                onChange={(event) => onPatch({ [field]: event.currentTarget.value || null })}
              >
                <option value="">{words.any}</option>
                {value && !known && <option value={value}>当前选择</option>}
                {options[field].map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        {isScoped(scope) && (
          <button type="button" className="ql-text-btn ql-clear un-hit" onClick={clear}>
            <X aria-hidden="true" className="ql-clear-icon" />
            清除范围
          </button>
        )}
      </p>
    </div>
  );
}
