// Loft state: URL params (variant, screen, theme, data state, device, chrome) plus the
// in-memory learner state shared by every variant, so switching variants never loses a draft.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { draftSteps, explanation, hints, judgement, problem, readiness, suggestions } from './fixture.js';
import { warmMath } from './shared.jsx';

const DEFAULTS = { v: 'a', screen: 'home', theme: 'light', state: 'normal', device: 'desktop', chrome: '1', help: '0', round: '2' };

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (q.get(key)) out[key] = q.get(key);
  return out;
}

export function withTransition(update) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

const Ctx = createContext(null);

export function LoftProvider({ children }) {
  const [params, setParams] = useState(readParams);
  const [steps, setSteps] = useState(() => draftSteps.map((s) => ({ ...s })));
  const [save, setSave] = useState('saved');
  const [hintsSeen, setHintsSeen] = useState({ h1: true, h2: false });
  const [explain, setExplain] = useState({ phase: 'closed', shown: 0 });
  const [helpOpen, setHelpOpen] = useState(params.help === '1');
  const [hidden, setHidden] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [palette, setPalette] = useState(false);
  const [failWrites, setFailWrites] = useState(false);
  const [prefetch, setPrefetch] = useState({});
  const [part2, setPart2] = useState('working');
  const saveTimer = useRef(0);
  const streamTimer = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = params.theme;
  }, [params.theme]);

  useEffect(() => {
    warmMath([
      problem.stem,
      ...problem.parts.flatMap((p) => [p.text, p.check ?? '']),
      ...draftSteps.map((s) => s.text),
      ...hints.map((h) => h.text),
      ...explanation,
      judgement.unknown,
      ...readiness.map((r) => r.detail),
      ...suggestions.map((s) => s.purpose),
    ]);
  }, []);

  const setParam = useCallback((patch, { transition = false, push = false } = {}) => {
    const apply = () =>
      setParams((prev) => {
        const next = { ...prev, ...patch };
        const q = new URLSearchParams();
        for (const [k, val] of Object.entries(next)) if (val !== DEFAULTS[k]) q.set(k, val);
        const url = `${window.location.pathname}${q.toString() ? `?${q}` : ''}`;
        window.history[push ? 'pushState' : 'replaceState'](null, '', url);
        return next;
      });
    if (transition) withTransition(apply);
    else apply();
  }, []);

  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-2), { id, ...t }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.ms ?? 5000);
    return id;
  }, []);
  const dismissToast = useCallback((id) => setToasts((list) => list.filter((x) => x.id !== id)), []);

  const markSaving = useCallback(() => {
    setSave('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSave('saved'), 420);
  }, []);

  const editStep = useCallback(
    (id, text) => {
      setSteps((list) => list.map((s) => (s.id === id ? { ...s, text } : s)));
      markSaving();
    },
    [markSaving],
  );

  const addStep = useCallback(
    (text) => {
      withTransition(() =>
        setSteps((list) => [
          ...list.map((s) => ({ ...s, current: false })),
          { id: `s${list.length + 1}-${Date.now()}`, text, origin: 'tonight', help: 'none', current: true, fresh: true },
        ]),
      );
      markSaving();
    },
    [markSaving],
  );

  const revealHint = useCallback((id) => {
    withTransition(() => setHintsSeen((h) => ({ ...h, [id]: true })));
  }, []);

  const startExplain = useCallback(() => {
    if (explain.phase !== 'closed') return;
    const total = explanation.join('').length;
    setExplain({ phase: 'streaming', shown: 0 });
    let shown = 0;
    window.clearInterval(streamTimer.current);
    streamTimer.current = window.setInterval(() => {
      shown = Math.min(total, shown + 6);
      setExplain({ phase: shown >= total ? 'recording' : 'streaming', shown });
      if (shown >= total) {
        window.clearInterval(streamTimer.current);
        // Stream end is not commitment: the label flips only after the committed state is re-read.
        window.setTimeout(() => setExplain({ phase: 'done', shown }), 500);
      }
    }, 45);
  }, [explain.phase]);

  // Optimistic write with rollback: hide now, restore on failure.
  const hideSuggestion = useCallback(
    (id, label) => {
      withTransition(() => setHidden((h) => [...h, id]));
      const restore = () => withTransition(() => setHidden((h) => h.filter((x) => x !== id)));
      if (failWrites) {
        window.setTimeout(() => {
          restore();
          toast({ tone: 'critical', text: `${label}没有保存成功，已恢复原样。`, action: '重试', onAction: () => {} });
        }, 650);
        return;
      }
      toast({ text: `${label}。`, action: '撤销', onAction: restore });
    },
    [failWrites, toast],
  );

  const submitPart2 = useCallback(() => {
    withTransition(() => setPart2('checking'));
    window.setTimeout(() => {
      if (failWrites) {
        withTransition(() => setPart2('working'));
        toast({ tone: 'critical', text: '提交没有成功，草稿仍保存在本机。', action: '重试', onAction: () => {} });
        return;
      }
      withTransition(() => setPart2('mismatch'));
    }, 700);
  }, [failWrites, toast]);

  const value = useMemo(
    () => ({
      params,
      setParam,
      go: (screen) => setParam({ screen }, { transition: true, push: true }),
      steps,
      editStep,
      addStep,
      save,
      hintsSeen,
      revealHint,
      explain,
      startExplain,
      helpOpen,
      setHelpOpen: (open) => withTransition(() => setHelpOpen(open)),
      hidden,
      hideSuggestion,
      suggestions: suggestions.filter((s) => !hidden.includes(s.id)),
      expanded,
      toggleExpanded: (id) => withTransition(() => setExpanded((cur) => (cur === id ? null : id))),
      toasts,
      toast,
      dismissToast,
      palette,
      setPalette,
      failWrites,
      setFailWrites,
      prefetch,
      preload: (key, how) => setPrefetch((p) => (p[key] ? p : { ...p, [key]: how })),
      part2,
      submitPart2,
    }),
    [
      params,
      setParam,
      steps,
      editStep,
      addStep,
      save,
      hintsSeen,
      revealHint,
      explain,
      startExplain,
      helpOpen,
      hidden,
      hideSuggestion,
      expanded,
      toasts,
      toast,
      dismissToast,
      palette,
      failWrites,
      prefetch,
      part2,
      submitPart2,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLoft() {
  return useContext(Ctx);
}
