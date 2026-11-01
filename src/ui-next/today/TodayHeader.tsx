import { Button, Mascot } from '@/ui-next/public';
import './today.css';

export function TodayHeader({
  navigate,
  onCompanion,
}: {
  navigate(to: string): void;
  onCompanion(): void;
}) {
  return (
    <header className="un-today-heading">
      <div>
        <h1>今日</h1>
        <p>继续练习，看看学习依据，再决定 AI 的建议。</p>
        <div className="un-today-actions">
          <Button variant="primary" onClick={() => navigate('/practice')}>
            去练习
          </Button>
          <Button variant="secondary" onClick={() => navigate('/record')}>
            录入材料
          </Button>
          <Button variant="ghost" onClick={onCompanion}>
            学习伙伴
          </Button>
        </div>
      </div>
      <Mascot />
    </header>
  );
}
