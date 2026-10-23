import { scopedPracticeHref } from '@/ui/lib/routes';
import { openCopilot, setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { Button } from '@/ui-next/public';
import { type QuestionFullDetail, focusTitle } from './library-api';
import { shortDay } from './QuestionLine';

const MAX_PRACTICE = 3;

/**
 * 接着做: practise what this question trains (there is no single-question practice yet, so the
 * link is per knowledge point), or talk it through with the companion, which opens on this
 * question. When each knowledge point is next due sits beside its button.
 */
export function NextSteps({
  detail,
  lead,
  navigate,
}: {
  detail: QuestionFullDetail;
  /** False when a notice above already holds the page's main action. */
  lead: boolean;
  navigate: (to: string) => void;
}) {
  const due = new Map(
    detail.scheduling.per_knowledge.map((k) => [k.knowledge_id, k.due_at_sec] as const),
  );
  const knowledge = detail.labels.slice(0, MAX_PRACTICE);
  const askCompanion = () => {
    setCompanionFocus({ kind: 'question', id: detail.id, title: focusTitle(detail) });
    openCopilot();
  };

  return (
    <section className="qd-section" aria-labelledby="qd-next-h">
      <h2 id="qd-next-h" className="qd-section-title">
        接着做
      </h2>
      <ul className="qd-next">
        {knowledge.map((k, index) => {
          const dueAt = due.get(k.id);
          return (
            <li key={k.id} className="qd-next-row">
              <div className="qd-next-text">
                <span className="qd-next-name">练「{k.name}」</span>
                <span className="qd-quiet">
                  {dueAt ? `按复习间隔，${shortDay(dueAt)} 该复习` : '还没排进复习'}
                </span>
              </div>
              <Button
                size="sm"
                variant={lead && index === 0 ? 'primary' : 'secondary'}
                onClick={() => navigate(scopedPracticeHref(k.id))}
              >
                去练
              </Button>
            </li>
          );
        })}
        <li className="qd-next-row">
          <div className="qd-next-text">
            <span className="qd-next-name">问学习伙伴</span>
            <span className="qd-quiet">它会看着这道题和你聊：讲思路、找错因、出一道类似的。</span>
          </div>
          <Button
            size="sm"
            variant={lead && knowledge.length === 0 ? 'primary' : 'secondary'}
            onClick={askCompanion}
          >
            打开
          </Button>
        </li>
      </ul>
    </section>
  );
}
