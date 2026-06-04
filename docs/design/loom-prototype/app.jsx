// Loom · app shell — sidebar nav, routing, theme, mobile drawer.
const NAV = [
  { section: "织造" },
  { id: "today",     label: "今日",   icon: "today" },
  { id: "review",    label: "复习",   icon: "review", count: 12 },
  { id: "practice",  label: "练习",   icon: "layers", count: 2 },
  { id: "record",    label: "录入",   icon: "record" },
  { section: "整理" },
  { id: "inbox",     label: "收件箱", icon: "inbox", count: 9 },
  { id: "mistakes",  label: "错题",   icon: "mistakes", count: 3 },
  { id: "questions", label: "题库",   icon: "quiz" },
  { id: "items",     label: "学习项", icon: "items" },
  { id: "knowledge", label: "知识",   icon: "knowledge" },
];

// mobile bottom bar: ≤5 core entries; overflow lives behind 更多 → slide-out
const MOBILE_NAV = [
  { id: "today", label: "今日", icon: "today" },
  { id: "review", label: "复习", icon: "review" },
  { id: "record", label: "录入", icon: "record" },
  { id: "knowledge", label: "知识", icon: "knowledge" },
  { id: "__more", label: "更多", icon: "menu" },
];

// round-2b stubs removed — ScreenCoach / ScreenEvents are real screens now.

// round-2b: all surfaces are real now.
const SCREENS = {
  today: ScreenToday, review: ScreenReview, practice: ScreenPractice, record: ScreenRecord,
  inbox: ScreenInbox, mistakes: ScreenMistakes, questions: ScreenQuestions, items: ScreenItems, knowledge: ScreenKnowledge,
  coach: ScreenCoach, events: ScreenEvents,
  "knowledge/": ScreenKnowledgeDetail, "items/": ScreenItemDetail,
  "learning-sessions": ScreenSessions, "learning-sessions/": ScreenSessionDetail,
  "notes/": ScreenNoteReader,
};
const TITLES = {
  today: "今日", review: "复习", practice: "练习", record: "录入", inbox: "收件箱", mistakes: "错题",
  items: "学习项", knowledge: "知识", coach: "Coach", events: "事件链", "learning-sessions": "学习会话", notes: "笔记", questions: "题库",
};
// parse "base/param" — returns { base, param }
function parseRoute(hash) {
  const raw = hash.replace(/^#/, "") || "today";
  const slash = raw.indexOf("/");
  if (slash === -1) return { base: raw, param: null };
  return { base: raw.slice(0, slash), param: raw.slice(slash + 1) };
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": ["#D97757", "#C2553A", "#A93F26", "#FAEDE5", "#EDC3AE", "#6E2C18"],
  "density": "regular",
  "radius": "default",
  "weave": true,
  "anim": true,
  "dataState": "ok"
}/*EDITMODE-END*/;

const ACCENTS = {
  "赭石 Clay": ["#D97757", "#C2553A", "#A93F26", "#FAEDE5", "#EDC3AE", "#6E2C18"],
  "靛青 Indigo": ["#4F6E8E", "#3D5876", "#2C4360", "#E2E9F1", "#BACBDC", "#1F3247"],
  "苍翠 Pine": ["#4A7C59", "#3A6747", "#2A5236", "#E2EBDF", "#B5CDB8", "#1F3625"],
  "栗紫 Mauve": ["#8A5A78", "#744863", "#5E384F", "#F0E6EC", "#D4BACA", "#3E2235"],
};

function App() {
  const [route, setRoute] = React.useState(() => location.hash.slice(1) || "today");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("loom-theme") || "light");
  const [collapsed, setCollapsed] = React.useState(() => localStorage.getItem("loom-rail") === "1");
  const [mobileNav, setMobileNav] = React.useState(false);
  const [copilot, setCopilot] = React.useState(false);
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const { base, param } = parseRoute(route);

  React.useEffect(() => {
    const r = document.documentElement, a = t.accent || [];
    const vars = ["--coral", "--coral-hover", "--coral-press", "--coral-soft", "--coral-line", "--coral-ink"];
    vars.forEach((v, i) => a[i] && r.style.setProperty(v, a[i]));
    r.setAttribute("data-density", t.density);
    r.setAttribute("data-radius", t.radius);
    r.setAttribute("data-weave", t.weave ? "on" : "off");
    r.setAttribute("data-anim", t.anim ? "on" : "off");
  }, [t]);

  React.useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("loom-theme", theme); }, [theme]);
  React.useEffect(() => { localStorage.setItem("loom-rail", collapsed ? "1" : "0"); }, [collapsed]);
  React.useEffect(() => { window.__openCopilot = () => setCopilot(true); }, []);
  React.useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || "today");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (r) => { location.hash = r; setRoute(r); setMobileNav(false); window.scrollTo({ top: 0 }); };
  const ui = { dataState: t.dataState };
  // resolve screen: detail routes use "base/" key + param; bare routes use base.
  const Screen = param != null ? (SCREENS[base + "/"] || SCREENS[base] || ScreenToday) : (SCREENS[base] || ScreenToday);
  const navActive = base;

  // admin is a separate shell — no main app chrome
  if (base === "admin") {
    return (
      <React.Fragment>
        <AdminShell go={go} route={route} ui={ui} />
        <TweaksPanelMount t={t} setTweak={setTweak} />
      </React.Fragment>
    );
  }

  return (
    <div className={"app" + (collapsed ? " rail-collapsed" : "")}>
      {mobileNav && <div className="scrim open" style={{ zIndex: 25 }} onClick={() => setMobileNav(false)} />}

      <aside className={"sidebar" + (mobileNav ? " open" : "")}>
        <button className="brand" onClick={() => go("today")}>
          <span className="brand-mark"><BrandMark size={32} /></span>
          <span>
            <div className="brand-name">Loom</div>
            <div className="brand-sub">织 · 学习编织台</div>
          </span>
        </button>

        <nav className="nav">
          {NAV.map((n, i) => n.section ? (
            <div key={i} className="nav-section-label">{n.section}</div>
          ) : (
            <button key={n.id} className={"nav-item" + (navActive === n.id ? " is-active" : "")} onClick={() => go(n.id)} title={n.label}>
              <Icon name={n.icon} size={19} />
              <span className="nav-label">{n.label}</span>
              {n.count != null && <span className="nav-count tnum">{n.count}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="nav-item sidebar-foot-full" onClick={() => setCopilot(true)}>
            <Icon name="copilot" size={19} /><span className="nav-label">Copilot</span>
          </button>
          <button className="nav-item sidebar-foot-full" onClick={() => go("admin/runs")} title="Admin">
            <Icon name="settings" size={19} /><span className="nav-label">Admin</span>
          </button>
          <div className="sidebar-foot-row">
            <button className="profile-mini">
              <span className="avatar">{DATA.user.initial}</span>
              <span className="sidebar-foot-full" style={{ minWidth: 0 }}>
                <div className="pm-name">{DATA.user.name}</div>
                <div className="pm-sub">{DATA.user.plan}</div>
              </span>
            </button>
            <IconBtn icon={theme === "light" ? "moon" : "sun"} size={16} title="切换主题" onClick={() => setTheme(theme === "light" ? "dark" : "light")} />
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMobileNav(true)}><Icon name="menu" size={18} /></button>
          <button className="icon-btn rail-toggle" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "展开侧栏" : "折叠侧栏"} aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} aria-pressed={collapsed} style={{ display: window.innerWidth <= 720 ? "none" : "grid" }}>
            <Icon name="panelLeft" size={16} className={collapsed ? "rail-toggle-on" : ""} />
          </button>
          <div className="crumbs">
            <span>Loom</span><span className="sep">/</span><b>{TITLES[base] || base}</b>
            {param != null && <><span className="sep">/</span><b className="mono">{param}</b></>}
          </div>
          <div className="topbar-spacer" />
          <div className="searchbox">
            <Icon name="search" size={15} />
            <span>搜索卡片、节点、错题…</span>
            <kbd>⌘K</kbd>
          </div>
          <IconBtn icon="copilot" size={18} title="Copilot" onClick={() => setCopilot(true)} />
        </header>

        <main key={route}>
          <Screen go={go} ui={ui} param={param} />
        </main>
      </div>

      {/* mobile bottom bar — ≤5 core entries */}
      <nav className="mobile-tabbar">
        {MOBILE_NAV.map((n) => {
          const active = n.id === "__more" ? false : navActive === n.id;
          return (
            <button key={n.id} className={"mtab" + (active ? " is-active" : "")}
              onClick={() => n.id === "__more" ? setMobileNav(true) : go(n.id)}>
              <Icon name={n.icon} size={20} />
              <span className="mtab-l">{n.label}</span>
            </button>
          );
        })}
      </nav>

      <CopilotDrawer open={copilot} onClose={() => setCopilot(false)} />

      <TweaksPanelMount t={t} setTweak={setTweak} />
    </div>
  );
}

function TweaksPanelMount({ t, setTweak }) {
  return (
      <TweaksPanel title="Tweaks">
        <TweakSection label="主题色 Accent" />
        <TweakColor label="色线" value={t.accent}
          options={Object.values(ACCENTS)}
          onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="排版 Layout" />
        <TweakRadio label="密度" value={t.density} options={["compact", "regular", "comfy"]}
          onChange={(v) => setTweak("density", v)} />
        <TweakRadio label="圆角" value={t.radius} options={["sharp", "default", "round"]}
          onChange={(v) => setTweak("radius", v)} />
        <TweakSection label="动效 Motion" />
        <TweakToggle label="过渡与入场动画" value={t.anim} onChange={(v) => setTweak("anim", v)} />
        <TweakToggle label="首页织纹背景" value={t.weave} onChange={(v) => setTweak("weave", v)} />
        <TweakSection label="数据态 demo" />
        <TweakRadio label="区块状态" value={t.dataState} options={["ok", "loading", "empty", "error"]} onChange={(v) => setTweak("dataState", v)} />
      </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
