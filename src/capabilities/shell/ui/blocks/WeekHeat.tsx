// M4-T6 (YUK-319)：7 天活动热力（设计稿 screen-today.jsx WeekHeat）。
// 偏差：设计稿 4×7 网格是假数据演示；真数据源 workbench summary week_heat
// 是过去 7 天（升序，末位今日）单行；heat-axis 标签从 day 日期派生星期，
// 不再写死「一~日」。分桶 heatLevel 见 workbench-api。
// YUK-1713 — M3E presentation (today-m3e.css .td-heat*): primary-tinted levels, no pop-in
// animation (motion only on change). Labels and levels are unchanged.

import type { WorkbenchSummary } from '../workbench-api';
import { heatLevel } from '../workbench-api';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

function weekdayOf(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '?' : WEEKDAY[d.getDay()];
}

export function WeekHeat({ heat }: { heat: WorkbenchSummary['week_heat'] }) {
  return (
    <div className="td-heat">
      <ul className="td-heat-row" aria-label="过去 7 天活动">
        {heat.map((h) => {
          const label = `${h.day}，星期${weekdayOf(h.day)}，${h.count} 次活动`;
          return (
            <li
              key={h.day}
              className="td-heat-cell"
              aria-label={label}
              data-lvl={heatLevel(h.count)}
              title={label}
            />
          );
        })}
      </ul>
      <div className="td-heat-axis un-num" aria-hidden="true">
        {heat.map((h) => (
          <span key={h.day}>
            {weekdayOf(h.day)} · {h.count}
          </span>
        ))}
      </div>
    </div>
  );
}
