import { Button } from '@/ui-next/public';
import type { QuestionFullDetail } from './library-api';
import { SERVING_COMMAND_WORDS } from './library-copy';
import { newActionKey, useServingAction } from './use-question-writes';

type Serving = QuestionFullDetail['serving'];

/**
 * The one release action the server offers for a held question, or a plain note when it is
 * already queued. Nothing when the server offers nothing.
 */
export function ServingButton({
  serving,
  variant = 'secondary',
}: {
  serving: Serving;
  variant?: 'primary' | 'secondary';
}) {
  const run = useServingAction();
  if (serving.pending_action) {
    return <span className="ql-note">已提交，排队处理中</span>;
  }
  const action = serving.next_action;
  if (!action) return null;
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={run.isPending}
      onClick={() => run.mutate({ action, key: newActionKey() })}
    >
      {run.isPending ? '正在提交…' : (SERVING_COMMAND_WORDS[action.command] ?? '处理')}
    </Button>
  );
}
