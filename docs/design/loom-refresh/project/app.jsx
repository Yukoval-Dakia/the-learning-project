// Loom · app shell — sidebar nav, routing, theme, mobile drawer.
const NAV = [
  { section: "织造" },
  { id: "today",     label: "今日",   icon: "today" },
  { id: "practice",  label: "练习",   icon: "layers", count: 5 },
  { id: "record",    label: "录入",   icon: "record" },
  { section: "整理" },
  { id: "drafts",    label: "草稿审核", icon: "checkCircle", count: 30 },
  { id: "inbox",     label: "收件箱", icon: "inbox", count: 9 },
  { id: "mistakes",  label: "错题",   icon: "mistakes", count: 3 },
  { id: "questions", label: "题库",   icon: "quiz" },
  { id: "items",     label: "学习项", icon: "items" },
  { id: "knowledge", label: "知识",   icon: "knowledge" },
  { id: "coach",     label: "Coach", icon: "target" },
];

// mobile bottom bar: ≤5 core entries; overflow lives behind 更多 → slide-out
const MOBILE_NAV = [
  { id: "today", label: "今日", icon: "today" },
  { id: "practice", label: "练习", icon: "layers" },
  { id: "record", label: "录入", icon: "record" },
  { id: "knowledge", label: "知识", icon: "knowledge" },
  { id: "__more", label: "更多", icon: "menu" },
];

// round-2b stubs removed — ScreenCoach / ScreenEvents are real screens now.

// round-2b: all surfaces are real now.
const SCREENS = {
  today: ScreenToday, review: ScreenReview, practice: ScreenPracticeFace, "practice/": ScreenPracticeFace, "practice-legacy": ScreenPractice, record: ScreenRecord,
  inbox: ScreenInbox, mistakes: ScreenMistakes, questions: ScreenQuestions, items: ScreenItems, knowledge: ScreenKnowledge,
  drafts: ScreenDraftReview,
  coach: CoachHub, events: ScreenEvents, copilot: ScreenCopilot,
  "agent-notes": ScreenAgentNotes,
  "knowledge/": ScreenKnowledgeDetail, "items/": ScreenItemDetail, "questions/": ScreenQuestionDetail,
  "learning-sessions": ScreenSessions, "learning-sessions/": ScreenSessionDetail,
  "notes/": ScreenNoteReader,
  // cold-start first-session flow
  welcome: ScreenWelcome, "onboard-upload": OnboardRecord, starter: ScreenStarter,
  placement: ScreenPlacement, profile: ScreenProfile,
};
const TITLES = {
  today: "今日", review: "复习", practice: "练习", record: "录入", inbox: "收件箱", mistakes: "错题", drafts: "草稿审核",
  items: "学习项", knowledge: "知识", coach: "Coach", events: "事件链", "learning-sessions": "学习会话", notes: "笔记", questions: "题库", copilot: "Copilot", "agent-notes": "AI 观察",
  welcome: "首会设定", "onboard-upload": "上传材料", starter: "起始集", placement: "定位练习", profile: "起始档案",
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
  "refine": true,
  "dataState": "ok",
  "reviewLayout": "split",
  "aiMeta": true,
  "draftVolume": "many",
  "handoffPlace": "并列",
  "handoffCard": "缕带",
  "handoffMastery": "档条",
  "handoffDensity": "里程碑",
  "handoffState": "ok",
  "handoffJobFail": true,
  "graphMode": "frontier",
  "copilotState": "normal",
  "hintLadder": "h0h5",
  "ladderState": "ok",
  "coachView": "efficacy",
  "vizMode": "rows",
  "effWindow": "attempt",
  "transferMode": "highlight",
  "showSource": true,
  "selfMode": "rows",
  "effState": "ok",
  "recordState": "ok",
  "coldStart": false,
  "obWelcome": "default",
  "obPlacement": "answer",
  "obProfile": "fresh",
  "obVerify": "tap"
}/*EDITMODE-END*/;

const ACCENTS = {
  "赭石 Clay": ["#D97757", "#C2553A", "#A93F26", "#FAEDE5", "#EDC3AE", "#6E2C18"],
  "靛青 Indigo": ["#4F6E8E", "#3D5876", "#2C4360", "#E2E9F1", "#BACBDC", "#1F3247"],
  "苍翠 Pine": ["#4A7C59", "#3A6747", "#2A5236", "#E2EBDF", "#B5CDB8", "#1F3625"],
  "栗紫 Mauve": ["#8A5A78", "#744863", "#5E384F", "#F0E6EC", "#D4BACA", "#3E2235"],
};

function App() {
  const [route, setRoute] = React.useState(() => location.hash.slice(1) || localStorage.getItem("loom-route") || "today");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("loom-theme") || "light");
  const [collapsed, setCollapsed] = React.useState(() => localStorage.getItem("loom-rail") === "1");
  const [mobileNav, setMobileNav] = React.useState(false);
  const [copilot, setCopilot] = React.useState(false);
  const [palette, setPalette] = React.useState(false);
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
    r.setAttribute("data-refine", t.refine === false ? "off" : "on");
  }, [t]);

  React.useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("loom-theme", theme); }, [theme]);
  React.useEffect(() => { localStorage.setItem("loom-rail", collapsed ? "1" : "0"); }, [collapsed]);
  React.useEffect(() => { window.__openCopilot = () => setCopilot(true); }, []);
  React.useEffect(() => {
    const onK = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener("keydown", onK);
    return () => window.removeEventListener("keydown", onK);
  }, []);
  React.useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || "today");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  React.useEffect(() => {
    const exit = () => setTweak("coldStart", false);
    window.addEventListener("ob-flow-exit", exit);
    return () => window.removeEventListener("ob-flow-exit", exit);
  }, [setTweak]);

  const go = (r) => { location.hash = r; setRoute(r); localStorage.setItem("loom-route", r); setMobileNav(false); window.scrollTo({ top: 0 }); };
  const ui = { dataState: t.dataState, reviewLayout: t.reviewLayout, aiMeta: t.aiMeta, draftVolume: t.draftVolume, handoffPlace: t.handoffPlace, handoffCard: t.handoffCard, handoffMastery: t.handoffMastery, handoffDensity: t.handoffDensity, handoffState: t.handoffState, handoffJobFail: t.handoffJobFail, graphMode: t.graphMode, hintLadder: t.hintLadder, ladderState: t.ladderState, coachView: t.coachView, vizMode: t.vizMode, effWindow: t.effWindow, transferMode: t.transferMode, showSource: t.showSource, selfMode: t.selfMode, effState: t.effState, recordState: t.recordState, obWelcome: t.obWelcome, obPlacement: t.obPlacement, obProfile: t.obProfile, obVerify: t.obVerify };
  // resolve screen: detail routes use "base/" key + param; bare routes use base.
  let Screen = param != null ? (SCREENS[base + "/"] || SCREENS[base] || ScreenToday) : (SCREENS[base] || ScreenToday);
  // cold-start: intercept an empty /today into the first-session entry
  if (base === "today" && t.coldStart) Screen = ColdToday;
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
          <button className={"nav-item sidebar-foot-full" + (navActive === "copilot" ? " is-active" : "")} onClick={() => go("copilot")}>
            <Icon name="copilot" size={19} /><span className="nav-label">Copilot</span><span className="nav-count" style={{ background: "transparent", color: "var(--ink-5)" }}><Icon name="maximize" size={13} /></span>
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
          <button className="searchbox" onClick={() => setPalette(true)} aria-label="搜索（⌘K）">
            <Icon name="search" size={15} />
            <span>搜索卡片、节点、错题…</span>
            <kbd>⌘K</kbd>
          </button>
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

      <CopilotDrawer open={copilot} onClose={() => setCopilot(false)} onExpand={() => { setCopilot(false); go("copilot"); }} copilotState={t.copilotState || "normal"} go={go} />

      <CommandPalette open={palette} onClose={() => setPalette(false)} go={go} />

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
        <TweakSection label="质感 Finish" />
        <TweakToggle label="视觉精修 Refined" value={t.refine !== false} onChange={(v) => setTweak("refine", v)} />
        <TweakSection label="动效 Motion" />
        <TweakToggle label="过渡与入场动画" value={t.anim} onChange={(v) => setTweak("anim", v)} />
        <TweakToggle label="首页织纹背景" value={t.weave} onChange={(v) => setTweak("weave", v)} />
        <TweakSection label="练习面 demo" />
        <TweakButton label="模拟 AI 白天增补 item" onClick={() => window.dispatchEvent(new CustomEvent("pface-inject"))} />
        <TweakButton label="重置练习面演示" secondary onClick={() => window.dispatchEvent(new CustomEvent("pface-reset"))} />
        <TweakSection label="今日 · 晨间交班缕" />
        <TweakRadio label="落点 · 留白①" value={t.handoffPlace || "并列"} options={["并列", "并入"]} onChange={(v) => setTweak("handoffPlace", v)} />
        <TweakRadio label="缕卡形态" value={t.handoffCard || "缕带"} options={["缕带", "交班帖"]} onChange={(v) => setTweak("handoffCard", v)} />
        <TweakRadio label="叙事浓度" value={t.handoffDensity || "里程碑"} options={["轻", "里程碑", "叙事"]} onChange={(v) => setTweak("handoffDensity", v)} />
        <TweakRadio label="mastery 隐喻" value={t.handoffMastery || "档条"} options={["档条", "方向", "织线"]} onChange={(v) => setTweak("handoffMastery", v)} />
        <TweakSelect label="交班缕状态" value={t.handoffState || "ok"} options={[{ value: "ok", label: "稳态 · 有交班" }, { value: "firstNight", label: "空夜 · 首日(预告)" }, { value: "quietNight", label: "空夜 · 安静夜(极简)" }, { value: "loading", label: "加载中 · 正在准备" }, { value: "degrade", label: "部分降级 + job 失败" }]} onChange={(v) => setTweak("handoffState", v)} />
        <TweakToggle label="job 失败如实交代 · 留白③" value={t.handoffJobFail !== false} onChange={(v) => setTweak("handoffJobFail", v)} />
        <TweakSection label="知识图 · A5" />
        <TweakRadio label="图导航模式" value={t.graphMode || "frontier"} options={["frontier", "focus"]} onChange={(v) => setTweak("graphMode", v)} />
        <TweakSection label="编排者 Copilot · A3" />
        <TweakSelect label="对话状态 demo" value={t.copilotState || "normal"} options={["normal", "pr", "run", "proactive", "partial", "toolfail", "empty-reply", "blank"]} onChange={(v) => setTweak("copilotState", v)} />
        <TweakSection label="自主滑块 · A2" />
        <TweakRadio label="阶梯分阶" value={t.hintLadder || "h0h5"} options={["h0h5", "three"]} onChange={(v) => setTweak("hintLadder", v)} />
        <TweakSelect label="滑块状态 demo" value={t.ladderState || "ok"} options={["ok", "loading", "fail", "empty"]} onChange={(v) => setTweak("ladderState", v)} />
        <TweakSection label="Coach 复盘中枢 · 视图" />
        <TweakRadio label="落地视图" value={t.coachView || "efficacy"} options={[{ value: "activity", label: "活动量" }, { value: "calibration", label: "校准诊断" }, { value: "efficacy", label: "成效趋势" }]} onChange={(v) => setTweak("coachView", v)} />
        <TweakSection label="成效趋势 · 轨迹 + 数据态" />
        <TweakRadio label="可视化" value={t.vizMode || "rows"} options={[{ value: "rows", label: "折线行" }, { value: "grid", label: "小倍数" }, { value: "stream", label: "河流带" }]} onChange={(v) => setTweak("vizMode", v)} />
        <TweakSelect label="数据态 demo" value={t.effState || "ok"} options={[{ value: "ok", label: "ok · 正常" }, { value: "empty", label: "empty · 零作答" }, { value: "single", label: "single · 全单点" }, { value: "lowconf", label: "lowconf · 全还嫩" }, { value: "regress", label: "regress · 全退步" }, { value: "error", label: "error · 取不到" }, { value: "loading", label: "loading" }]} onChange={(v) => setTweak("effState", v)} />
        <TweakRadio label="迁移 · 留白2" value={t.transferMode || "highlight"} options={[{ value: "highlight", label: "联动高亮" }, { value: "reserve", label: "仅预留" }, { value: "off", label: "关" }]} onChange={(v) => setTweak("transferMode", v)} />
        <TweakToggle label="来源二态 · 留白3" value={t.showSource !== false} onChange={(v) => setTweak("showSource", v)} />
        <TweakRadio label="开放题自评 · 留白4" value={t.selfMode || "rows"} options={[{ value: "rows", label: "自评行" }, { value: "off", label: "关" }]} onChange={(v) => setTweak("selfMode", v)} />
        <TweakSection label="冷启首会流 Onboarding" />
        <TweakButton label="▶ 走一遍首会流（从设定起）" onClick={() => { location.hash = "welcome"; }} />
        <TweakToggle label="冷库态（/today 空 → 首会入口）" value={t.coldStart} onChange={(v) => setTweak("coldStart", v)} />
        <TweakSelect label="① Welcome 状态" value={t.obWelcome || "default"} options={["default", "submitfail"]} onChange={(v) => setTweak("obWelcome", v)} />
        <TweakSelect label="③ Placement 状态" value={t.obPlacement || "answer"} options={["answer", "loading", "sourcing", "judgefail"]} onChange={(v) => setTweak("obPlacement", v)} />
        <TweakRadio label="④ 档案数据" value={t.obProfile || "fresh"} options={["fresh", "sparse"]} onChange={(v) => setTweak("obProfile", v)} />
        <TweakSelect label="④ 重算核对 · #41" value={t.obVerify || "tap"} options={["tap", "auto", "drift"]} onChange={(v) => setTweak("obVerify", v)} />
        <TweakSection label="录入出口 · A8" />
        <TweakSelect label="录入状态 demo" value={t.recordState || "ok"} options={["ok", "figurecrop", "docx", "emptyblock", "pdftimeout", "rescuefail"]} onChange={(v) => setTweak("recordState", v)} />
        <TweakSection label="数据态 demo" />
        <TweakRadio label="区块状态（含空夜态）" value={t.dataState} options={["ok", "loading", "empty", "error"]} onChange={(v) => setTweak("dataState", v)} />
        <TweakSection label="草稿审核 /drafts" />
        <TweakRadio label="默认布局" value={t.reviewLayout || "split"} options={["split", "compact"]} onChange={(v) => setTweak("reviewLayout", v)} />
        <TweakToggle label="显示 AI 置信度 / 成本" value={t.aiMeta !== false} onChange={(v) => setTweak("aiMeta", v)} />
        <TweakRadio label="草稿池数据量" value={t.draftVolume || "many"} options={["none", "few", "mid", "many"]} onChange={(v) => setTweak("draftVolume", v)} />
      </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
