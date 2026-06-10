// Loom · app shell — nav, topbar, mobile tab bar, theme + route hooks.
const { useState: useStateS, useEffect: useEffectS, useCallback: useCb } = React;

function useTheme() {
  const [theme, setTheme] = useStateS(() => localStorage.getItem('loom-theme') || 'light');
  useEffectS(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('loom-theme', theme);
  }, [theme]);
  return [theme, () => setTheme(t => t === 'light' ? 'dark' : 'light')];
}

function useRoute() {
  const [route, setRoute] = useStateS(() => localStorage.getItem('loom-route') || 'today');
  const go = useCb((r) => {
    setRoute(r);
    localStorage.setItem('loom-route', r);
    document.querySelector('.main')?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, []);
  return [route, go];
}

const NAV_TITLES = {
  today: '今日', review: '复习', record: '录入', items: '学习项',
  knowledge: '知识图谱', mistakes: '错题与收件箱',
};

function Brand({ onClick }) {
  return (
    <button className="brand" onClick={onClick}>
      <span className="brand-mark"><Icon name="loom" size={30} stroke={1.7} /></span>
      <span>
        <div className="brand-name">Loom</div>
        <div className="brand-sub">织·学习系统</div>
      </span>
    </button>
  );
}

function Sidebar({ route, go, open, onClose }) {
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <Brand onClick={() => { go('today'); onClose(); }} />
      <nav className="nav">
        {LOOM.nav.map((it, i) => it.section
          ? <div key={'s'+i} className="nav-section-label">{it.section}</div>
          : (
            <button key={it.id} className={`nav-item ${route === it.id ? 'is-active' : ''}`}
              onClick={() => { go(it.id); onClose(); }} title={it.label}>
              <Icon name={it.icon} size={20} />
              <span className="nav-label">{it.label}</span>
              {it.count != null && <span className="nav-count tnum">{it.count}</span>}
            </button>
          )
        )}
      </nav>
      <div className="sidebar-foot">
        <button className="profile" title={LOOM.user.name}>
          <span className="avatar">{LOOM.user.initial}</span>
          <span className="profile-meta sidebar-foot-full">
            <div className="profile-name">{LOOM.user.name}</div>
            <div className="profile-sub">{LOOM.user.plan}</div>
          </span>
        </button>
      </div>
    </aside>
  );
}

function Topbar({ route, theme, toggleTheme, onMenu, onCopilot }) {
  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label="菜单"><Icon name="menu" /></button>
      <div className="crumbs hide-mobile">
        <Icon name="loom" size={15} /> Loom <Icon name="chevronRight" size={13} /> <b>{NAV_TITLES[route]}</b>
      </div>
      <div className="topbar-spacer" />
      <label className="searchbar hide-mobile">
        <Icon name="search" size={16} />
        <input placeholder="搜索学习项、卡片、笔记…" className="search-ph" />
        <kbd>⌘K</kbd>
      </label>
      <button className="icon-btn only-mobile" aria-label="搜索"><Icon name="search" size={18} /></button>
      <button className="icon-btn" onClick={toggleTheme} aria-label="切换主题">
        <Icon name="moon" size={18} className="ico-moon" />
        <Icon name="sun" size={18} className="ico-sun" />
      </button>
      <button className="btn btn-primary btn-sm hide-mobile" onClick={onCopilot}>
        <Icon name="copilot" size={16} /> Copilot
      </button>
    </header>
  );
}

function TabBar({ route, go, onCopilot }) {
  const icons = { today: 'today', review: 'review', record: 'record', knowledge: 'knowledge', mistakes: 'mistakes' };
  return (
    <nav className="tabbar">
      {LOOM.tabs.map(t => (
        <button key={t} className={`tab ${route === t ? 'is-active' : ''}`} onClick={() => go(t)}>
          {(t === 'review' || t === 'mistakes') && <span className="tab-dot" />}
          <Icon name={icons[t]} size={22} />
          <span>{NAV_TITLES[t]}</span>
        </button>
      ))}
    </nav>
  );
}

Object.assign(window, { useTheme, useRoute, Sidebar, Topbar, TabBar, NAV_TITLES });
