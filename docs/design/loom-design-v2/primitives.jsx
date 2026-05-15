/* Loom v2 — Primitives.
   Shape preserved from loom-design v1; mechanics updated for event-driven core.
   Loaded as non-module Babel; everything exported to window. */

// ── Brand mark (3 woven curves through a frame) ────────────
const Brand = ({ size = 22 }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="10" y="10" width="44" height="44" rx="4" strokeOpacity="0.35" />
    <path d="M10 22 C 22 22, 22 30, 32 30 S 42 22, 54 22" />
    <path d="M10 32 C 22 32, 22 40, 32 40 S 42 32, 54 32" strokeOpacity="0.7" />
    <path d="M10 42 C 22 42, 22 50, 32 50 S 42 42, 54 42" strokeOpacity="0.45" />
  </svg>
);

// ── Lucide icons (inlined paths; 24-unit grid, 1.75 stroke) ─
const ICONS = {
  // nav
  layout:     <><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></>,
  inbox:      <><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></>,
  pen:        <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
  refresh:    <><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>,
  alert:      <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>,
  bookmark:   <><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></>,
  list:      <><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></>,
  network:    <><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></>,
  // chrome
  spark:      <><path d="M12 3v3"/><path d="M12 18v3"/><path d="m4.93 4.93 2.12 2.12"/><path d="m16.95 16.95 2.12 2.12"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m4.93 19.07 2.12-2.12"/><path d="m16.95 7.05 2.12-2.12"/><circle cx="12" cy="12" r="3"/></>,
  bot:        <><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M8 16h.01"/><path d="M16 16h.01"/></>,
  user:       <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
  clock:      <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
  moon:       <><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></>,
  cog:        <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
  // proposal / action verbs
  variant:    <><path d="M16 3h5v5"/><path d="m21 3-7 7"/><path d="M8 21H3v-5"/><path d="m3 21 7-7"/></>,
  note:       <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></>,
  quiz:       <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></>,
  check:      <><polyline points="20 6 9 17 4 12"/></>,
  x:          <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
  arrowR:     <><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></>,
  arrowL:     <><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></>,
  send:       <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
  camera:     <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></>,
  upload:     <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>,
  search:     <><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></>,
  chev:       <><polyline points="9 18 15 12 9 6"/></>,
  plus:       <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
  trash:      <><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></>,
  dollar:     <><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
  zap:        <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>,
  hash:       <><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></>,
  link:       <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
  info:       <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>,
  brain:      <><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04Z"/></>,
};
const Icon = ({ name, size = 18, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'}
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name] || null}
  </svg>
);

// ── Button ─────────────────────────────────────────────────
const Button = ({ variant = 'primary', size, icon, iconRight, children, ...rest }) => (
  <button className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''}`} {...rest}>
    {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
    {children}
    {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
  </button>
);

// ── Badge (capsule) ────────────────────────────────────────
const Badge = ({ tone = 'neutral', children, dot, dotStatic }) => (
  <span className={`badge tone-${tone}`}>
    {dot && <span className={`dot${dotStatic ? ' static' : ''}`} />}
    {children}
  </span>
);

const StatusBadge = ({ status }) => {
  const m = ({
    pending:     ['neutral', '待办'],
    in_progress: ['hard',    '进行中'],
    done:        ['good',    '已完成'],
    extracted:   ['info',    'extracted'],
    partial:     ['hard',    'partial'],
    failed:      ['again',   'failed'],
    queued:      ['neutral', 'queued'],
    extracting:  ['hard',    'extracting'],
  })[status] || ['neutral', status];
  return <Badge tone={m[0]}>{m[1]}</Badge>;
};

// CauseBadge — now derived from a `judge` event payload (cause object)
// Brief §4 voice rule: surface AI vs user, plus confidence.
const CauseBadge = ({ cause, pendingSinceSec }) => {
  if (!cause) {
    const elapsed = pendingSinceSec || 0;
    if (elapsed < 30) return <Badge tone="hard" dot>归因中...</Badge>;
    return <Badge tone="neutral">待归因</Badge>;
  }
  const isAi = cause.actor_kind === 'agent';
  const tone = isAi ? 'info' : 'good';
  const conf = cause.confidence != null ? ` (${Math.round(cause.confidence * 100)}%)` : '';
  const label = isAi ? `AI · ${cause.primary}${conf}` : `用户 · ${cause.primary}`;
  return <Badge tone={tone}>{label}</Badge>;
};

// ── ActorBadge — first-class for v2 (events have actor_kind) ──
const ACTOR_LABELS = {
  user: { glyph: 'user',  text: '用户',  tone: 'user' },
  agent: { glyph: 'bot',  text: 'AI',    tone: 'agent' },
  cron:  { glyph: 'moon', text: 'cron',  tone: 'cron' },
  system: { glyph: 'cog', text: 'system', tone: 'system' },
};
const ActorBadge = ({ actorKind, actorRef, compact }) => {
  const a = ACTOR_LABELS[actorKind] || ACTOR_LABELS.system;
  const label = actorRef && actorKind === 'agent' ? `${a.text} · ${actorRef}` : a.text;
  return (
    <span className={`actor ${a.tone}`} title={actorRef || actorKind}>
      <Icon name={a.glyph} size={11} />
      {!compact && <span>{label}</span>}
    </span>
  );
};

// ── Card ───────────────────────────────────────────────────
const Card = ({ children, className = '', pad = 'default' }) => (
  <div className={`card ${pad === 'lg' ? 'is-pad-lg' : ''} ${className}`}>{children}</div>
);

// ── PageHeader ─────────────────────────────────────────────
const PageHeader = ({ title, eyebrow, sub, children }) => (
  <header className="page-head">
    {eyebrow && <div className="meta">{eyebrow}</div>}
    <div className="page-head-row">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      <div className="page-head-actions">{children}</div>
    </div>
  </header>
);

// ── TopNav ─────────────────────────────────────────────────
const TopNav = ({ active, onNav, onCopilot, copilotOn }) => {
  const items = [
    { id: 'today',     label: '今日' },
    { id: 'record',    label: '录入' },
    { id: 'review',    label: '复习' },
    { id: 'mistakes',  label: '错题' },
    { id: 'items',     label: '学习项' },
    { id: 'knowledge', label: '知识' },
  ];
  return (
    <nav className="topnav">
      <button type="button" className="brand" onClick={() => onNav('today')}>
        <span className="brand-mark"><Brand size={22} /></span>
        <span className="brand-name">Loom</span>
      </button>
      <ul className="topnav-items">
        {items.map(it => (
          <li key={it.id}>
            <button type="button"
              className={`topnav-item ${active === it.id ? 'is-active' : ''}`}
              onClick={() => onNav(it.id)}>{it.label}</button>
          </li>
        ))}
      </ul>
      <div className="topnav-meta">
        <span className="topnav-version">phase 1c · adr-0006 v2</span>
        <button type="button"
          className={`copilot-btn ${copilotOn ? 'is-on' : ''}`}
          onClick={onCopilot}>
          {copilotOn ? <span className="dot" /> : <Icon name="bot" size={14} />}
          <span>Copilot</span>
        </button>
      </div>
    </nav>
  );
};

// ── EventChain — the v2 "查看推理" inspector ────────────────
// Renders an inline <details> with the caused_by chain leading to this event.
// Walks chain from root (oldest) → current (newest); current is highlighted.
function buildChain(eventId, eventsById) {
  const chain = [];
  let cur = eventsById[eventId];
  let safety = 16;
  while (cur && safety-- > 0) {
    chain.unshift(cur);
    cur = cur.caused_by_event_id ? eventsById[cur.caused_by_event_id] : null;
  }
  return chain;
}

const ACTION_LABEL = {
  attempt:   '尝试',
  judge:     '归因',
  propose:   '提议',
  generate:  '生成',
  review:    '复习',
  rate:      '评级',
  extract:   '抽取',
  import:    '入库',
  'experimental:ask_copilot':    'ask',
  'experimental:explain':        'explain',
  'experimental:trigger_dreaming_scan': 'trigger',
  'experimental:scan':           'scan',
  'experimental:critique':       'critique',
};
function describeEvent(ev) {
  switch (ev.action) {
    case 'attempt': {
      const out = ev.outcome === 'failure' ? '答错' : ev.outcome === 'success' ? '答对' : '部分';
      const q = ev.payload?.answer_md ? ev.payload.answer_md.slice(0, 60) : '';
      return <>{out} <code>{ev.subject_id}</code>{q ? <span className="quote">{q}</span> : null}</>;
    }
    case 'judge': {
      const c = ev.payload?.cause || {};
      const conf = c.confidence != null ? `（${Math.round(c.confidence * 100)}%）` : '';
      return <>归因 → <code>{c.primary}</code>{conf}{c.ai_analysis_md ? <span className="quote">{c.ai_analysis_md}</span> : null}</>;
    }
    case 'propose': {
      const p = ev.payload || {};
      return <>提议 {ev.subject_kind} <code>{p.name || ev.subject_id}</code>{p.reasoning ? <span className="quote">{p.reasoning}</span> : null}</>;
    }
    case 'generate': {
      const p = ev.payload || {};
      return <>生成 <code>{p.artifact_kind || ev.subject_kind}</code> · {p.title}</>;
    }
    case 'review': {
      const r = ev.payload?.fsrs_rating;
      return <>复习 → <code>{r}</code></>;
    }
    case 'rate': {
      return <>评级 → <code>{ev.payload?.rating}</code> on <code>{ev.subject_id}</code></>;
    }
    case 'extract': {
      return <>抽取 layout=<code>{ev.payload?.layout_quality}</code></>;
    }
    case 'experimental:ask_copilot':
      return <>问 Copilot<span className="quote">{ev.payload?.text}</span></>;
    case 'experimental:explain':
      return <>Copilot 解释<span className="quote">{ev.payload?.text_md}</span></>;
    case 'experimental:trigger_dreaming_scan':
      return <>触发 Dreaming 扫描</>;
    case 'experimental:scan':
      return <>扫描 <code>{ev.subject_id}</code></>;
    case 'experimental:critique':
      return <>Critique → <code>{ev.outcome}</code>{ev.payload?.reason ? <span className="quote">{ev.payload.reason}</span> : null}</>;
    default:
      return <>{ev.action} · <code>{ev.subject_kind}</code></>;
  }
}

const EventChain = ({ eventId, eventsById, label = '查看推理链' }) => {
  const chain = buildChain(eventId, eventsById);
  if (chain.length <= 1) return null;
  return (
    <details className="chain">
      <summary>
        <Icon name="chev" size={12} />
        <span>{label}</span>
        <span className="tag">· {chain.length} event{chain.length > 1 ? 's' : ''}</span>
      </summary>
      <div className="chain-body">
        <div className="chain-rail">
          {chain.map((ev, i) => (
            <div key={ev.id} className={`chain-row is-${ev.actor_kind}`}>
              <span className="gut" />
              <div>
                <div className="meta">
                  <ActorBadge actorKind={ev.actor_kind} actorRef={ev.actor_ref} compact />
                  <span>{ACTION_LABEL[ev.action] || ev.action}</span>
                  <span>·</span>
                  <code>{ev.id}</code>
                  {ev.task_run_id && <span>· {ev.task_run_id}</span>}
                  {ev.cost_micro_usd && <span>· ${(ev.cost_micro_usd / 1e6).toFixed(4)}</span>}
                </div>
                <div className="desc">{describeEvent(ev)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
};

// ── ProposalCard — for AI-generated artifacts attached to events ─
// Shape used in /mistakes and inside event-card children blocks.
const ARTIFACT_ICON = { variant: 'variant', note: 'note', quiz: 'quiz', summary: 'list' };
const ARTIFACT_LABEL = { variant: '变式', note: '笔记', quiz: '小测', summary: '总结' };

const ProposalCard = ({ event, eventsById, status, onAccept, onDismiss }) => {
  const p = event.payload || {};
  const kind = p.artifact_kind || event.subject_kind;
  const ico = ARTIFACT_ICON[kind] || 'spark';
  const label = ARTIFACT_LABEL[kind] || kind;
  const cls = status === 'accept' ? 'is-accepted' : status === 'dismiss' ? 'is-dismissed' : '';
  return (
    <div className={`proposal ${cls}`}>
      <div className="proposal-head">
        <div className="row">
          <Badge tone="info" dot dotStatic>
            <Icon name={ico} size={11} /> AI · {label}
          </Badge>
          <span className="title">{p.title || event.subject_id}</span>
        </div>
        <div className="meta-row">
          <span>{event.actor_ref}</span>
          {event.task_run_id && <span>· {event.task_run_id}</span>}
          {event.cost_micro_usd != null && <span>· ${(event.cost_micro_usd / 1e6).toFixed(4)}</span>}
        </div>
      </div>
      {p.body_md && <div className="body">{p.body_md}</div>}
      {p.reasoning && !p.body_md && <div className="body" style={{ fontFamily: 'var(--font-sans)' }}>{p.reasoning}</div>}
      <div className="proposal-actions">
        <Button variant="good" size="sm" icon="check" onClick={() => onAccept && onAccept(event)} disabled={!!status}>
          {status === 'accept' ? '已接受' : '接受'}
        </Button>
        <Button variant="ghost" size="sm" icon="x" onClick={() => onDismiss && onDismiss(event)} disabled={!!status}>
          {status === 'dismiss' ? '已忽略' : '忽略'}
        </Button>
        <span className="spacer" />
        <EventChain eventId={event.id} eventsById={eventsById} label="推理" />
      </div>
    </div>
  );
};
/* good-tone button is just secondary with overrides — use existing classes */

// ── Lane (Today orchestrator) ──────────────────────────────
const Lane = ({ eyebrow, title, badge, stub, children }) => (
  <section className={`lane ${stub ? 'is-stub' : ''}`}>
    <header className="lane-head">
      <div>
        <div className="lane-eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
      </div>
      {badge}
    </header>
    <div className="lane-body">
      {children}
    </div>
  </section>
);

// ── CostRibbon ─────────────────────────────────────────────
const CostRibbon = ({ today, budget, breakdown }) => {
  const pct = Math.min(100, Math.round((today / budget) * 100));
  return (
    <div className="cost-ribbon">
      <Icon name="dollar" size={13} />
      <span>今日 <b>${today.toFixed(2)}</b> / 预算 <b>${budget.toFixed(2)}</b></span>
      <span className="bar"><span style={{ width: pct + '%' }} /></span>
      {breakdown && breakdown.map((b, i) => (
        <span key={i}>· {b.label} <b>${b.value.toFixed(2)}</b></span>
      ))}
      <span className="spacer" />
      <span><a href="#logs">详见 logs</a></span>
    </div>
  );
};

// Helper: format relative time
function relTime(ts) {
  const now = Date.now() / 1000;
  const d = now - ts;
  if (d < 60) return `${Math.floor(d)} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

Object.assign(window, {
  Brand, Icon, Button, Badge, StatusBadge, CauseBadge, ActorBadge,
  Card, PageHeader, TopNav, Lane, EventChain, ProposalCard, CostRibbon,
  describeEvent, buildChain, ACTION_LABEL, relTime,
});
