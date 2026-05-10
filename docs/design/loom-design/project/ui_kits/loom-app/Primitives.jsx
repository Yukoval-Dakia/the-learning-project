// Shared UI primitives for the Loom app UI kit.
// Loaded as a non-module Babel file; everything is exported to window.

const Brand = ({ size = 22 }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="10" y="10" width="44" height="44" rx="4" strokeOpacity="0.35" />
    <path d="M10 22 C 22 22, 22 30, 32 30 S 42 22, 54 22" />
    <path d="M10 32 C 22 32, 22 40, 32 40 S 42 32, 54 32" strokeOpacity="0.7" />
    <path d="M10 42 C 22 42, 22 50, 32 50 S 42 42, 54 42" strokeOpacity="0.45" />
  </svg>
);

const Icon = ({ name, size = 18 }) => {
  const paths = {
    record: <><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.855z"/></>,
    list: <><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></>,
    review: <><path d="m2 9 3-3 3 3"/><path d="M13 18H7a2 2 0 0 1-2-2V6"/><path d="m22 15-3 3-3-3"/><path d="M11 6h6a2 2 0 0 1 2 2v10"/></>,
    network: <><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></>,
    upload: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></>,
    bookmark: <><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></>,
    plus: <><path d="M5 12h14"/><path d="M12 5v14"/></>,
    arrow: <><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></>,
    close: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
    info: <><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
};

const Button = ({ variant = "primary", children, ...rest }) => (
  <button className={`btn btn-${variant}`} {...rest}>{children}</button>
);

const Badge = ({ tone = "neutral", children }) => (
  <span className={`badge tone-${tone}`}>{children}</span>
);

const StatusBadge = ({ status }) => {
  const map = {
    pending: { label: "待办", tone: "neutral" },
    in_progress: { label: "进行中", tone: "hard" },
    done: { label: "已完成", tone: "good" },
  };
  const m = map[status] || { label: status, tone: "neutral" };
  return <Badge tone={m.tone}>{m.label}</Badge>;
};

const CauseBadge = ({ cause, createdAt }) => {
  if (!cause) {
    const elapsed = Date.now() / 1000 - createdAt;
    if (elapsed < 30) return <Badge tone="hard"><span className="dot" /> 归因中...</Badge>;
    return <Badge tone="neutral">待归因</Badge>;
  }
  const isAi = cause.user_edited === false;
  const tone = isAi ? "info" : "good";
  const conf = cause.confidence != null ? ` (${Math.round(cause.confidence * 100)}%)` : "";
  const label = isAi ? `AI · ${cause.primary_category}${conf}` : `用户 · ${cause.primary_category}`;
  return <Badge tone={tone}>{label}</Badge>;
};

const Card = ({ children, className = "" }) => (
  <div className={`card ${className}`}>{children}</div>
);

const PageHeader = ({ title, eyebrow, children }) => (
  <header className="page-head">
    {eyebrow && <div className="meta">{eyebrow}</div>}
    <div className="page-head-row">
      <h1>{title}</h1>
      <div className="page-head-actions">{children}</div>
    </div>
  </header>
);

const TopNav = ({ active, onNav }) => {
  const items = [
    { id: "today",    label: "今日", path: "/today" },
    { id: "record",   label: "录入", path: "/record" },
    { id: "review",   label: "复习", path: "/review" },
    { id: "mistakes", label: "错题", path: "/mistakes" },
    { id: "items",    label: "学习项", path: "/learning-items" },
    { id: "knowledge",label: "知识", path: "/knowledge" },
  ];
  return (
    <nav className="topnav">
      <button type="button" className="brand" onClick={() => onNav("home")}>
        <span className="brand-mark"><Brand size={22} /></span>
        <span className="brand-name">Loom</span>
      </button>
      <ul className="topnav-items">
        {items.map(it => (
          <li key={it.id}>
            <button type="button"
              className={`topnav-item ${active === it.id ? "is-active" : ""}`}
              onClick={() => onNav(it.id)}>{it.label}</button>
          </li>
        ))}
      </ul>
      <div className="topnav-meta meta">phase 1a · sub 4a</div>
    </nav>
  );
};

const TabBar = ({ active, onNav }) => {
  const items = [
    { id: "today",    label: "今日", icon: "review" },
    { id: "record",   label: "录入", icon: "record" },
    { id: "review",   label: "复习", icon: "list" },
    { id: "mistakes", label: "错题", icon: "bookmark" },
    { id: "knowledge",label: "知识", icon: "network" },
  ];
  return (
    <nav className="tabbar">
      {items.map(it => (
        <button key={it.id} type="button"
          className={`tab ${active === it.id ? "is-active" : ""}`}
          onClick={() => onNav(it.id)}>
          <Icon name={it.icon} size={20} />
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
};

Object.assign(window, { Brand, Icon, Button, Badge, StatusBadge, CauseBadge, Card, PageHeader, TopNav, TabBar });
