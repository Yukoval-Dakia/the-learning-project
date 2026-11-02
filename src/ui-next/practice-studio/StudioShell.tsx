import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  Home,
  Inbox,
  LibraryBig,
  Menu,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import { useId } from 'react';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { ToolButton } from './controls';
import './studio.css';
import './renderers.css';

type Destination = { id: string; label: string; current: boolean; onSelect(): void };
const icons = {
  today: Home,
  practice: BookOpen,
  record: Upload,
  questions: LibraryBig,
  inbox: Inbox,
};
const primaryIds = ['today', 'practice', 'questions', 'record', 'inbox'];
export function StudioNavigation(p: {
  items: readonly Destination[];
  navigationOpen: boolean;
  onNavigationOpen(value: boolean): void;
  blocked: boolean;
  nudgeCount: number;
  theme: 'light' | 'dark';
  companionOpen: boolean;
  inboxCount?: number;
  inboxCountUncertain: boolean;
  onSearch(): void;
  onTheme(): void;
  onCompanion(): void;
}) {
  const expanded = p.navigationOpen;
  const setExpanded = p.onNavigationOpen;
  const dialogId = useId();
  const trap = useFocusTrap(expanded, () => setExpanded(false));
  const current = p.items.find((item) => item.current);
  const destination = (item: Destination) => {
    const Icon = icons[item.id as keyof typeof icons] ?? CalendarDays;
    return (
      <button
        type="button"
        key={item.id}
        className="un-st-destination"
        aria-current={item.current ? 'page' : undefined}
        onClick={() => {
          setExpanded(false);
          item.onSelect();
        }}
      >
        <span className="un-st-nav-icon">
          <Icon size={23} aria-hidden="true" />
          {item.id === 'inbox' && ((p.inboxCount ?? 0) > 0 || p.inboxCountUncertain) && (
            <span
              className="un-st-nav-count"
              role="img"
              aria-label={p.inboxCountUncertain ? '有待确认事项' : `${p.inboxCount}项待办`}
            >
              {p.inboxCountUncertain ? '•' : p.inboxCount}
            </span>
          )}
        </span>
        <span>{item.label}</span>
      </button>
    );
  };
  const primaries = primaryIds.flatMap((id) => {
    const item = p.items.find((value) => value.id === id);
    return item ? [item] : [];
  });
  return (
    <>
      <a className="un-st-skip" href="#main-content">
        跳到主要内容
      </a>
      <nav className="un-st-rail" inert={p.blocked || expanded} aria-label="全局导航">
        <a
          href="/today"
          className="un-st-brand"
          onClick={(event) => {
            const home = p.items.find((item) => item.id === 'today');
            if (home) {
              event.preventDefault();
              home.onSelect();
            }
          }}
        >
          <span aria-hidden="true">L</span>
          <span>Loom</span>
        </a>
        <div className="un-st-rail-destinations">
          {primaries.map(destination)}
          <button
            type="button"
            className="un-st-destination"
            aria-expanded={expanded}
            aria-controls={dialogId}
            onClick={() => setExpanded(true)}
          >
            <span className="un-st-nav-icon">
              <Menu size={23} />
            </span>
            <span>更多</span>
          </button>
        </div>
        <div className="un-st-rail-tools">
          <ToolButton label="搜索页面和知识节点" onClick={p.onSearch}>
            <Search size={22} />
          </ToolButton>
          <ToolButton label={p.theme === 'light' ? '切换为深色' : '切换为浅色'} onClick={p.onTheme}>
            {p.theme === 'light' ? <Moon size={22} /> : <Sun size={22} />}
          </ToolButton>
        </div>
      </nav>
      <header className="un-st-topbar" inert={p.blocked || expanded}>
        <div className="un-st-location">
          <span className="un-st-mobile-brand">Loom</span>
          <span>{current?.label ?? '学习'}</span>
          <ChevronRight size={15} aria-hidden="true" />
          <span className="un-st-secondary">学习工作区</span>
        </div>
        <div className="un-st-top-tools">
          <span className="un-st-mobile-tool">
            <ToolButton
              label={p.theme === 'light' ? '切换为深色' : '切换为浅色'}
              onClick={p.onTheme}
            >
              {p.theme === 'light' ? <Moon size={21} /> : <Sun size={21} />}
            </ToolButton>
          </span>
          <button
            type="button"
            className="un-st-companion-toggle"
            aria-expanded={p.companionOpen}
            onClick={p.onCompanion}
          >
            {p.companionOpen ? <PanelRightClose size={21} /> : <PanelRightOpen size={21} />}
            <span>学习伙伴</span>
            {p.nudgeCount > 0 && (
              <span className="un-st-nudge-count" role="img" aria-label={`${p.nudgeCount}条建议`}>
                {p.nudgeCount}
              </span>
            )}
          </button>
        </div>
      </header>
      <nav className="un-st-bottom-nav" inert={p.blocked || expanded} aria-label="核心目的地">
        {primaries.filter((item) => item.id !== 'record').map(destination)}
        <button
          type="button"
          className="un-st-destination"
          aria-expanded={expanded}
          aria-controls={dialogId}
          onClick={() => setExpanded(true)}
        >
          <span className="un-st-nav-icon">
            <Menu size={22} />
          </span>
          <span>更多</span>
        </button>
      </nav>
      {expanded && (
        <div className="un-st-nav-modal">
          <button
            type="button"
            className="un-st-nav-scrim"
            aria-label="收起导航"
            tabIndex={-1}
            onClick={() => setExpanded(false)}
          />
          <section
            id={dialogId}
            ref={trap}
            role="dialog"
            aria-modal="true"
            aria-label="全部目的地"
            className="un-st-navigation-sheet"
            onKeyDown={(event) => {
              if (
                /^[1-9]$/.test(event.key) ||
                ((event.ctrlKey || event.metaKey) && event.key === 'Enter')
              )
                event.stopPropagation();
            }}
          >
            <header>
              <h2>前往</h2>
              <ToolButton label="收起导航" onClick={() => setExpanded(false)}>
                <X size={22} />
              </ToolButton>
            </header>
            <nav aria-label="全部目的地">{p.items.map(destination)}</nav>
            <button
              type="button"
              className="un-st-button"
              onClick={() => {
                setExpanded(false);
                p.onSearch();
              }}
            >
              <Search size={20} />
              搜索页面和知识节点
            </button>
          </section>
        </div>
      )}
    </>
  );
}
