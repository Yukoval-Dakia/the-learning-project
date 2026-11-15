import { type ComponentType, useCallback, useRef, useState } from 'react';
import { ApiError, apiJson } from '@/ui/lib/api';
import { Button } from '@/ui-next/public';
import {
  FailedTurnPracticeTarget,
  type FailedTurnPracticeTargetT,
} from '../failed-turn-practice-target-contract';
import { ConversationMarkdown } from './companion/ConversationMarkdown';

export interface FailedTurnReferenceProps {
  runId: string;
  sessionId: string;
  disabled: boolean;
}

export type FailedTurnReferenceRenderer = ComponentType<FailedTurnReferenceProps>;

export interface FailedTurnReferenceClient {
  readTarget(runId: string, sessionId: string): Promise<FailedTurnPracticeTargetT>;
  revealReference(issuanceId: string): Promise<{ reference_md: string | null }>;
}

export async function readCopilotFailedTurnPracticeTarget(
  runId: string,
  sessionId: string,
): Promise<FailedTurnPracticeTargetT> {
  return FailedTurnPracticeTarget.parse(
    await apiJson<unknown>(
      `/api/copilot/runs/${encodeURIComponent(runId)}/practice-target?session_id=${encodeURIComponent(sessionId)}`,
      { cache: 'no-store' },
    ),
  );
}

type ReferenceView =
  | { status: 'idle' | 'loading' | 'empty' }
  | { status: 'unavailable' | 'unknown'; message: string }
  | {
      status: 'ready';
      target: Extract<FailedTurnPracticeTargetT, { status: 'ready' }>;
      markdown: string;
    };

function unavailableMessage(
  reason: Extract<FailedTurnPracticeTargetT, { status: 'unavailable' }>['reason'],
) {
  switch (reason) {
    case 'no_saved_practice_target':
      return '这次提问没有可确认的原题记录，无法查看封存参考。';
    case 'revoked':
      return '原提问或这次作答已不可用于查看参考。';
    case 'outcome_unknown':
      return '这次求助的结果尚未确认，暂不能从这里查看参考。';
    default:
      return '这次求助目前不能从这里查看参考。';
  }
}

/** Only an explicit click resolves the original target and invokes the injected reveal owner. */
export function FailedTurnReference({
  runId,
  sessionId,
  disabled,
  client,
}: FailedTurnReferenceProps & { client: FailedTurnReferenceClient }) {
  const [view, setView] = useState<ReferenceView>({ status: 'idle' });
  const inFlight = useRef(false);
  const lifetime = useRef(0);
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    return () => {
      lifetime.current += 1;
    };
  }, []);

  async function reveal() {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    const activeLifetime = lifetime.current;
    let requestedReference = false;
    setView({ status: 'loading' });
    try {
      const target = await client.readTarget(runId, sessionId);
      // Leaving this message while its GET is pending must not start a later disclosure POST.
      if (lifetime.current !== activeLifetime) return;
      if (target.status === 'unavailable') {
        setView({ status: 'unavailable', message: unavailableMessage(target.reason) });
        return;
      }
      requestedReference = true;
      const result = await client.revealReference(target.issuance_id);
      if (lifetime.current !== activeLifetime) return;
      if (result.reference_md === null) setView({ status: 'empty' });
      else if (typeof result.reference_md === 'string' && result.reference_md.trim())
        setView({ status: 'ready', target, markdown: result.reference_md });
      else
        setView({
          status: 'unknown',
          message: '参考内容未能确认，可能已经记录援助。不会自动再次请求。',
        });
    } catch (error) {
      if (lifetime.current !== activeLifetime) return;
      const denied =
        error instanceof ApiError &&
        (error.status === 403 ||
          error.status === 404 ||
          [
            'coordinate_mismatch',
            'reveal_unavailable',
            'study_restricted',
            'study_source_unknown',
            'study_source_restricted',
          ].includes(error.code ?? ''));
      setView(
        denied
          ? { status: 'unavailable', message: '原题参考已不可用，未显示参考内容。' }
          : {
              status: 'unknown',
              message: requestedReference
                ? '这次查看的结果尚未确认，可能已经记录援助。不会自动再次请求。'
                : '暂时无法确认原题参考入口，尚未发起查看参考的请求。',
            },
      );
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section ref={attach} aria-label="查看封存参考">
      <p className="un-cp-reply-status">查看参考会计入一次援助；已提交的作答回执保留原记录。</p>
      {view.status === 'idle' || view.status === 'unknown' || view.status === 'loading' ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || view.status === 'loading'}
          onClick={() => void reveal()}
        >
          {view.status === 'loading'
            ? '正在核对并读取…'
            : view.status === 'unknown'
              ? '再次查看已保存的完整参考'
              : '查看已保存的完整参考'}
        </Button>
      ) : null}
      {view.status === 'unavailable' || view.status === 'unknown' ? (
        <p className="un-cp-reply-status" role="status">
          {view.message}
        </p>
      ) : null}
      {view.status === 'empty' ? (
        <p className="un-cp-reply-status" role="status">
          这次发行没有封存完整参考。
        </p>
      ) : null}
      {view.status === 'ready' ? (
        <>
          <p className="un-cp-reply-status">
            封存参考 · 出处：原提问对应的这次作答 ·{' '}
            <a href={`/questions/${encodeURIComponent(view.target.question_id)}`}>原题</a>
          </p>
          <ConversationMarkdown className="un-cp-md">{view.markdown}</ConversationMarkdown>
        </>
      ) : null}
    </section>
  );
}
