import { useId } from 'react';
import './practice.css';

export interface PracticeNavigationProps {
  items: readonly { id: string; label: string; current: boolean; onSelect(): void }[];
  theme: 'light' | 'dark';
  companionOpen: boolean;
  inboxCount?: number;
  inboxCountUncertain: boolean;
  onSearch(): void;
  onTheme(): void;
  onCompanion(): void;
}

/** The existing shell owns navigation, theme, search and the one companion instance. */
export function PracticeNavigation(props: PracticeNavigationProps) {
  const id = useId();
  return (
    <header className="un-cr-appbar">
      <a className="un-cr-skip" href="#practice-content">
        跳到题目与作答
      </a>
      <nav aria-label="页面导航">
        <details className="un-cr-navigation">
          <summary>导航 · 练习</summary>
          <ul className="un-cr-list">
            {props.items.map((item) => (
              <li key={item.id}>
                <button
                  className="un-cr-button"
                  type="button"
                  aria-current={item.current ? 'page' : undefined}
                  onClick={item.onSelect}
                >
                  {item.label}
                  {item.id === 'inbox' && props.inboxCount !== undefined && (
                    <span>
                      {' '}
                      · {props.inboxCount}
                      {props.inboxCountUncertain ? '+' : ''}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </details>
      </nav>
      <section className="un-cr-actions" aria-labelledby={id}>
        <span id={id} className="un-cr-sr">
          页面工具
        </span>
        <button type="button" className="un-cr-button" onClick={props.onSearch}>
          搜索 <kbd>⌘K</kbd>
        </button>
        <button type="button" className="un-cr-button" onClick={props.onTheme}>
          切换为{props.theme === 'light' ? '深色' : '浅色'}
        </button>
        <button
          type="button"
          className="un-cr-button un-cr-tonal"
          aria-expanded={props.companionOpen}
          onClick={props.onCompanion}
        >
          学习伙伴
        </button>
      </section>
    </header>
  );
}
