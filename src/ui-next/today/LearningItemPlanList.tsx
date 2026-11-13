import { useId, useRef } from 'react';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, ChipToggle } from '@/ui-next/public';
import './learning-item-plan.css';

interface PlanRow {
  id: string;
  title: string;
  status: 'pending' | 'in_progress';
  user_pinned: boolean;
  due_at: string | null;
}

export interface PlanEditor {
  id: string;
  pinned: boolean;
  date: string;
  dirty: boolean;
  busy: boolean;
  blocked: boolean;
  unknown: boolean;
  error: string | null;
  changedElsewhere: boolean;
  available: boolean;
  onPin(value: boolean): void;
  onDate(value: string): void;
  onTomorrow(): void;
  onSave(): Promise<boolean>;
  onCancel(): void;
  onReconcile(): void;
}

export function LearningItemPlanList(p: {
  rows: PlanRow[];
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  expanded: boolean;
  page: number;
  hasNext: boolean;
  editor: PlanEditor | null;
  notice: string | null;
  timezone: string;
  onEdit(row: PlanRow): void;
  onRefresh(): void;
  onExpand(): void;
  onPage(direction: -1 | 1): void;
  onPractice(): void;
}) {
  const uid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const visible = p.expanded ? p.rows : p.rows.slice(0, 5);
  const closeEditor = () => {
    if (p.editor) triggers.current.get(p.editor.id)?.focus();
    p.editor?.onCancel();
  };
  return (
    <section className="un-plan un-m3e-bridge" aria-labelledby={`${uid}-heading`}>
      <div className="un-plan-heading">
        <h2 id={`${uid}-heading`} className="un-today-section-title" tabIndex={-1} ref={heading}>
          学习项安排
        </h2>
        <Button variant="quiet" disabled={p.refreshing || p.editor?.busy} onClick={p.onRefresh}>
          {p.refreshing ? '刷新中…' : '刷新'}
        </Button>
      </div>
      <div className="un-plan-panel">
        <p className="un-plan-help">保存后，可到练习页按当前信号重排。</p>
        {p.loading && <SkeletonLines rows={3} label="正在读取学习项" />}
        {p.error && (
          <RetryLine
            message={
              p.rows.length ? '列表刷新失败，仍显示上次读取的学习项。' : '学习项暂时无法读取。'
            }
            onRetry={p.onRefresh}
          />
        )}
        {!p.loading && !p.error && p.rows.length === 0 && <p>这一页暂无待安排的学习项。</p>}
        <ul className="un-plan-list" id={`${uid}-rows`}>
          {visible.map((row) => {
            const edit = p.editor?.id === row.id ? p.editor : null;
            const dateId = `${uid}-${row.id}-date`;
            return (
              <li key={row.id} className="un-plan-row">
                <div className="un-plan-row-heading">
                  <div className="un-plan-identity">
                    <h3>{row.title || '未命名学习项'}</h3>
                    <div className="un-plan-meta">
                      <span>{row.status === 'pending' ? '待开始' : '学习中'}</span>
                      {row.user_pinned && <Chip>已置顶</Chip>}
                      <span>
                        {row.due_at
                          ? `截止 ${new Date(row.due_at).toLocaleDateString()}`
                          : '未设截止日期'}
                      </span>
                      {row.due_at && new Date(row.due_at).getTime() < Date.now() && (
                        <span>已过期</span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="quiet"
                    aria-label={`调整：${row.title}`}
                    aria-expanded={Boolean(edit)}
                    ref={(node) => {
                      if (node) triggers.current.set(row.id, node);
                      else triggers.current.delete(row.id);
                    }}
                    onClick={() => p.onEdit(row)}
                    disabled={p.editor?.busy}
                  >
                    调整
                  </Button>
                </div>
                {edit && (
                  <form
                    className="un-plan-editor"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (await edit.onSave()) triggers.current.get(row.id)?.focus();
                    }}
                  >
                    <p className="un-plan-help">
                      {edit.dirty ? '未保存' : '当前设置'} · {row.title}
                    </p>
                    <ChipToggle
                      pressed={edit.pinned}
                      onPressedChange={edit.onPin}
                      disabled={edit.busy || edit.blocked}
                    >
                      优先安排
                    </ChipToggle>
                    <div className="un-plan-field">
                      <label htmlFor={dateId}>项目截止日期</label>
                      <input
                        id={dateId}
                        type="date"
                        min="0100-01-01"
                        max="9999-12-30"
                        value={edit.date}
                        disabled={edit.busy || edit.blocked}
                        onChange={(event) => edit.onDate(event.target.value)}
                        aria-describedby={`${dateId}-help`}
                      />
                      <p id={`${dateId}-help`} className="un-plan-help">
                        按本机时区 {p.timezone}，新选日期在当天结束时截止。
                        {row.due_at && `现有期限：${new Date(row.due_at).toLocaleString()}。`}
                      </p>
                    </div>
                    <div className="un-plan-actions">
                      <Button
                        variant="quiet"
                        disabled={edit.busy || edit.blocked}
                        onClick={edit.onTomorrow}
                      >
                        明天
                      </Button>
                      <Button
                        variant="quiet"
                        disabled={edit.busy || edit.blocked || !edit.date}
                        onClick={() => edit.onDate('')}
                      >
                        清除日期
                      </Button>
                    </div>
                    {edit.changedElsewhere && (
                      <p className="un-plan-help">
                        当前设置已在别处改变。你的未保存修改仍保留；保存只提交你改动的字段。
                      </p>
                    )}
                    {!edit.available && <p role="alert">这个学习项已不在当前可安排列表中。</p>}
                    {edit.error && (
                      <p className="un-plan-error" role="alert">
                        {edit.error}
                      </p>
                    )}
                    <div className="un-plan-actions">
                      <Button
                        type="submit"
                        disabled={!edit.dirty || edit.busy || edit.blocked || !edit.available}
                        aria-busy={edit.busy || undefined}
                      >
                        {' '}
                        {edit.busy ? '保存中…' : '保存'}{' '}
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={closeEditor}
                        disabled={edit.busy || edit.unknown}
                      >
                        取消
                      </Button>
                      {edit.unknown && (
                        <Button
                          variant="secondary"
                          disabled={p.refreshing}
                          onClick={edit.onReconcile}
                        >
                          读取保存结果
                        </Button>
                      )}
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        {p.notice && (
          <p role="status" className="un-plan-notice">
            {p.notice}
          </p>
        )}
        {(p.rows.length > 5 || p.expanded) && (
          <Button
            variant="quiet"
            aria-expanded={p.expanded}
            aria-controls={`${uid}-rows`}
            onClick={p.onExpand}
            disabled={p.editor?.busy}
          >
            {p.expanded ? '收起学习项' : '查看全部学习项'}
          </Button>
        )}
        {p.expanded && (
          <nav className="un-plan-actions" aria-label="学习项分页">
            <Button
              variant="quiet"
              disabled={p.page === 0 || p.refreshing || p.editor?.busy}
              onClick={() => {
                p.onPage(-1);
                heading.current?.focus();
              }}
            >
              上一页
            </Button>
            <span>
              第 {p.page + 1} 页 · 本页 {p.rows.length} 项
            </span>
            <Button
              variant="quiet"
              disabled={!p.hasNext || p.refreshing || p.editor?.busy}
              onClick={() => {
                p.onPage(1);
                heading.current?.focus();
              }}
            >
              下一页
            </Button>
          </nav>
        )}
        <div className="un-plan-footer">
          <Button
            variant="quiet"
            onClick={p.onPractice}
            disabled={p.editor?.busy || p.editor?.unknown}
          >
            去今日练习
          </Button>
        </div>
      </div>
    </section>
  );
}
