// Today's 学习画像与依据 panel (M3E: today.css .un-today-panel; YUK-1713 moved its loading /
// error switch to AreaGate). Query, preview limit and every navigation target are unchanged.
import { useQuery } from '@tanstack/react-query';
import type { PlacementProfile, PlacementProfileClient } from '@/capabilities/onboarding/ui-public';
import { openCopilot } from '@/ui/lib/use-copilot-dwell';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button } from '@/ui-next/public';
import { AreaGate, type AreaStatus } from '../AreaGate';

const PREVIEW_KC_LIMIT = 3;

function queryStatus(isLoading: boolean, isError: boolean, hasData: boolean): AreaStatus {
  if (isError && !hasData) return 'error';
  if (isLoading && !hasData) return 'loading';
  return 'ok';
}

function ProfileBandBody({
  data,
  goalId,
  navigate,
}: {
  data: PlacementProfile;
  goalId: string;
  navigate: (to: string) => void;
}) {
  // The endpoint owns the full-scope selection and coverage; the preview is not a new ranking.
  const preview = (data.weakest ?? []).slice(0, PREVIEW_KC_LIMIT);
  if (data.totalKcs === 0) {
    return (
      <div>
        <p>这个目标还没有可评估的知识点，先录入材料。</p>
        <Button onClick={() => navigate('/record')}>录入材料</Button>
      </div>
    );
  }
  if (preview.length === 0) {
    return (
      <div>
        <p>这个目标有 {data.totalKcs} 个知识点，当前没有可展示的作答证据。</p>
        <Button onClick={() => navigate('/practice')}>去练习</Button>
      </div>
    );
  }
  return (
    <>
      <p>这是初步画像。证据条数不等于独立做对的题数，也不表示已经掌握。</p>
      <ul className="un-today-evidence-list">
        {preview.map((kc) => (
          <li key={kc.id}>
            <details>
              <summary>
                <span>{kc.name}</span>
                <span className="un-today-meta">
                  {kc.evidence_count == null ? '证据数量未提供' : `${kc.evidence_count} 条证据记录`}{' '}
                  · 初步
                </span>
              </summary>
              <div className="un-today-evidence-detail">
                <p>
                  依据当前目标的学习画像记录。这里尚未提供独立作答、受帮助作答的拆分及最近证据时间，因此不展示精确掌握百分比。
                </p>
                {kc.low_confidence && <p>当前记录标记为低置信，不能据此断定“不会”。</p>}
                <div className="un-today-actions">
                  <Button
                    variant="ghost"
                    onClick={() => navigate(`/knowledge/${encodeURIComponent(kc.id)}`)}
                  >
                    查看知识点与依据
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      openCopilot(
                        `我想核对并提出异议：知识点「${kc.name}」（${kc.id}），目标 ${goalId}。今日画像显示${kc.evidence_count == null ? '证据数量未提供' : `${kc.evidence_count} 条证据记录`}，标为初步。请先查看原始依据，再讨论是否需要纠正。我的补充是：`,
                        { send: false },
                      )
                    }
                  >
                    提出异议
                  </Button>
                </div>
                <p className="un-today-meta">
                  异议先填入学习伙伴输入框，由你补充并发送；不会直接更改画像。
                </p>
              </div>
            </details>
          </li>
        ))}
      </ul>
      <div className="un-today-actions">
        <p className="un-today-meta">
          {data.evidencedCount == null
            ? `共 ${data.totalKcs} 个知识点；证据覆盖数未提供`
            : `${data.evidencedCount} / ${data.totalKcs} 个知识点有证据`}
        </p>
        <Button
          variant="ghost"
          onClick={() => navigate(`/profile?goal=${encodeURIComponent(goalId)}`)}
        >
          查看完整画像
        </Button>
      </div>
    </>
  );
}

export type PlacementProfileReader = PlacementProfileClient['getPlacementProfile'];

export function ProfileBand({
  goal,
  navigate,
  getPlacementProfile,
}: {
  goal: { id: string; title: string };
  navigate: (to: string) => void;
  getPlacementProfile: PlacementProfileReader;
}) {
  const q = useQuery({
    queryKey: ['placement-profile', goal.id],
    queryFn: () => getPlacementProfile(goal.id),
  });
  return (
    <section className="un-today-panel">
      <h2>学习画像与依据</h2>
      <p className="un-today-meta">{goal.title}</p>
      {q.isError && q.data !== undefined && (
        <p role="status" className="td-stale">
          画像更新失败，下面保留上次读取的记录。
        </p>
      )}
      <AreaGate
        status={queryStatus(q.isLoading, q.isError, q.data !== undefined)}
        onRetry={() => void q.refetch()}
        errorText="学习画像暂不可用，不能据此判断你的掌握情况。"
        loading={<SkeletonLines rows={3} label="正在读取学习画像" />}
      >
        {q.data && <ProfileBandBody data={q.data} goalId={goal.id} navigate={navigate} />}
      </AreaGate>
    </section>
  );
}
