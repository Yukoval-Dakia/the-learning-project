import type { ReactNode, Ref } from 'react';
import './practice.css';

export interface CompanionSurfaceProps {
  layout: 'side' | 'float' | 'sheet';
  wide: boolean;
  titleId: string;
  surfaceRef: Ref<HTMLElement>;
  thinking: boolean;
  onEscape(): void;
  actions: readonly {
    id: string;
    label: string;
    enabled?: boolean;
    expanded?: boolean;
    controls?: string;
    pressed?: boolean;
    run(): void;
  }[];
  context: ReactNode;
  messages: ReactNode;
  history: ReactNode;
  runStatus: ReactNode;
  composer: ReactNode;
  requestedSession: ReactNode;
}

/** Layout only. Visit, focus trap, stream scroll, queued sending and each Stop stay with owners. */
export function CompanionSurface(props: CompanionSurfaceProps) {
  return (
    <section
      className="un-cr-owned-companion"
      data-layout={props.layout}
      data-wide={props.wide || undefined}
      ref={props.surfaceRef}
      {...(props.layout === 'sheet'
        ? { role: 'dialog', 'aria-modal': true }
        : { role: 'complementary' })}
      aria-labelledby={props.titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && props.layout !== 'sheet') {
          event.stopPropagation();
          props.onEscape();
        }
      }}
    >
      {props.requestedSession}
      <header className="un-cr-companion-header">
        <div>
          <h2 id={props.titleId}>学习伙伴</h2>
          <p role="status">{props.thinking ? '正在回应…' : '在这里'}</p>
        </div>
        <div className="un-cr-actions">
          {props.actions
            .filter(
              (action) => action.id === 'history' || action.id === 'new' || action.id === 'close',
            )
            .map((action) => (
              <button
                key={action.id}
                type="button"
                className="un-cr-button"
                disabled={action.enabled === false}
                aria-expanded={action.expanded}
                aria-controls={action.controls}
                aria-pressed={action.pressed}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          <details className="un-cr-companion-more">
            <summary>更多</summary>
            {props.actions
              .filter(
                (action) => action.id !== 'history' && action.id !== 'new' && action.id !== 'close',
              )
              .map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="un-cr-button"
                  disabled={action.enabled === false}
                  aria-expanded={action.expanded}
                  aria-controls={action.controls}
                  aria-pressed={action.pressed}
                  onClick={action.run}
                >
                  {action.label}
                </button>
              ))}
          </details>
        </div>
      </header>
      <div className="un-cr-companion-context">{props.context}</div>
      <div className="un-cr-companion-body">
        {props.messages}
        {props.history}
      </div>
      <footer className="un-cr-companion-footer">
        {props.runStatus}
        {props.composer}
      </footer>
    </section>
  );
}
