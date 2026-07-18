// M4-T6 (YUK-319)：7 天活动热力（设计稿 screen-today.jsx WeekHeat）。
// 偏差：设计稿 4×7 网格是假数据演示；真数据源 workbench summary week_heat
// 是过去 7 天（升序，末位今日）单行；heat-axis 标签从 day 日期派生星期，
// 不再写死「一~日」。分桶 heatLevel 见 workbench-api。

import type { WorkbenchSummary } from '../workbench-api';
import { heatLevel } from '../workbench-api';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

function weekdayOf(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '?' : WEEKDAY[d.getDay()];
}

export function WeekHeat({ heat }: { heat: WorkbenchSummary['week_heat'] }) {
  return (
    <div className="week-heat">
      <ul className="heat-row" aria-label="过去 7 天活动">
        {heat.map((h, i) => {
          const label = `${h.day}，星期${weekdayOf(h.day)}，${h.count} 次活动`;
          return (
            <li
              key={h.day}
              className="heat-cell"
              aria-label={label}
              data-lvl={heatLevel(h.count)}
              title={label}
              style={{ animationDelay: `${i * 12}ms` }}
            />
          );
        })}
      </ul>
      <div className="heat-axis" aria-hidden="true">
        {heat.map((h) => (
          <span key={h.day} className="meta">
            {weekdayOf(h.day)} · {h.count}
          </span>
        ))}
      </div>
    </div>
  );
}
