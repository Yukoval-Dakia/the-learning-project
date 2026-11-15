import { useCallback, useRef, useState } from 'react';
import { randomId } from '@/ui/lib/random-id';
import type { PaperDetail } from './practice-api';
import { usePracticeClient } from './practice-client';

/** Serializes this visit's navigation; a conflict requires a new, explicit visit. */
export function usePaperContinuation(artifactId: string, initial: PaperDetail['continuation']) {
  const { getPaperDetail, resumePaperTask, pausePaperTask, recordPaperCurrentStep } =
    usePracticeClient();
  const receipt = useRef(initial);
  const [resumed, setResumed] = useState(false);
  const [status, setStatus] = useState<
    'opening' | 'saved' | 'saving' | 'unrecorded' | 'readonly' | 'conflict' | 'unknown' | 'paused'
  >(initial?.target === 'answer' ? 'opening' : 'readonly');
  const statusRef = useRef(status);
  const update = (next: typeof status) => {
    statusRef.current = next;
    setStatus(next);
  };
  const opened = useRef<Promise<boolean> | null>(null);
  const pending = useRef<string | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const active = useRef(false);
  const report = useCallback((next: typeof status) => {
    statusRef.current = next;
    if (active.current) setStatus(next);
  }, []);

  const send = useCallback(
    async (stepId?: string, pause = false, keepalive = false) => {
      const prior = receipt.current;
      if (!prior || prior.revision === null) return false;
      const body = {
        task_ref: prior.task_ref,
        expected_revision: prior.revision,
        command_id: randomId(),
      };
      const accepted = (ack: PaperDetail['continuation']) =>
        ack?.task_ref.session_id === prior.task_ref.session_id &&
        ack.task_ref.occurrence_ref === prior.task_ref.occurrence_ref &&
        ack.last_command?.id === body.command_id &&
        ack.revision === body.expected_revision + 1 &&
        (stepId === undefined || ack.current_step?.issuance_id === stepId);
      try {
        const result = pause
          ? await pausePaperTask(body, keepalive)
          : stepId === undefined
            ? await resumePaperTask(body)
            : await recordPaperCurrentStep({ ...body, step_issuance_id: stepId });
        if (!accepted(result.continuation)) throw new Error('missing continuation receipt');
        receipt.current = result.continuation;
        return true;
      } catch {
        // A failed transport may follow a committed transaction. Read before deciding;
        // never turn a newer revision into permission to resend an old navigation.
        try {
          const result = await getPaperDetail(artifactId, prior.task_ref);
          const ack = result.continuation;
          if (accepted(ack)) {
            receipt.current = ack;
            return true;
          }
          report('conflict');
        } catch {
          report('unknown');
        }
        return false;
      }
    },
    [artifactId, getPaperDetail, resumePaperTask, pausePaperTask, recordPaperCurrentStep, report],
  );

  const open = useCallback(() => {
    active.current = true;
    if (receipt.current?.target !== 'answer' || ['conflict', 'unknown'].includes(statusRef.current))
      return Promise.resolve(false);
    if (statusRef.current === 'paused') report('opening');
    opened.current ??= send();
    return opened.current.then((ok) => {
      if (ok) {
        if (active.current) setResumed(true);
        report(
          receipt.current?.target !== 'answer'
            ? 'readonly'
            : receipt.current.current_step
              ? 'saved'
              : 'unrecorded',
        );
      }
      return ok;
    });
  }, [send, report]);

  const navigate = (issuanceId: string) => {
    if (initial?.target !== 'answer') return false;
    if (['conflict', 'unknown', 'paused'].includes(statusRef.current)) return false;
    pending.current = issuanceId;
    update('saving');
    if (running.current) return true;
    running.current = (async () => {
      if (!(await open())) {
        pending.current = null;
        return false;
      }
      while (pending.current !== null) {
        const next = pending.current;
        pending.current = null;
        report('saving');
        if (!(await send(next))) {
          pending.current = null;
          return false;
        }
        if (receipt.current?.target !== 'answer') {
          report('readonly');
          pending.current = null;
          return false;
        }
      }
      report('saved');
      return true;
    })().finally(() => {
      running.current = null;
    });
    return true;
  };

  const settle = useCallback(async () => {
    const operation = running.current ?? opened.current;
    if (operation)
      await Promise.race([operation, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    return statusRef.current === 'saved';
  }, []);
  const pause = useCallback(
    async (keepalive = false) => {
      await settle();
      if (!['saved', 'unrecorded'].includes(statusRef.current)) return false;
      const ok = await send(undefined, true, keepalive);
      if (ok) {
        opened.current = null;
        if (active.current) setResumed(false);
        report('paused');
      }
      return ok;
    },
    [send, settle, report],
  );
  const detach = useCallback(() => {
    active.current = false;
  }, []);
  return {
    status,
    canEdit:
      !initial ||
      (resumed &&
        receipt.current?.target === 'answer' &&
        ['saved', 'saving', 'unrecorded'].includes(status)),
    open,
    navigate,
    settle,
    pause,
    detach,
  };
}
