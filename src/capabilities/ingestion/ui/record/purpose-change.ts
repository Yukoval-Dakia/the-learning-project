import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import {
  type PurposeImpact,
  type PurposeInput,
  type PurposeResult,
  changePurpose,
  getPurposeImpact,
  purposeLocation,
} from './record-api';

import { recordKeys } from './recording-read';

type Receipt = PurposeResult['receipt'];
type Journal = {
  body: PurposeInput;
  location: string;
  resolution: 'open' | 'conflict' | 'refused';
};
type Current = PurposeImpact['current'];
const key = (id: string) => `loom-record-purpose:${encodeURIComponent(id)}`;

function restore(id: string): { journal: Journal | null; error: string | null } {
  if (typeof window === 'undefined') return { journal: null, error: null };
  try {
    const raw = sessionStorage.getItem(key(id));
    if (!raw) return { journal: null, error: null };
    const data = JSON.parse(raw);
    const body = data.body;
    if (
      !body ||
      typeof body.request_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id) ||
      typeof body.source_document_id !== 'string' ||
      !body.source_document_id ||
      !Number.isInteger(body.expected_version) ||
      body.expected_version < 0 ||
      !['allow', 'answer_only'].includes(body.target) ||
      data.location !== purposeLocation(id, body.request_id) ||
      !['open', 'conflict', 'refused'].includes(data.resolution)
    )
      throw new Error('invalid journal');
    return {
      journal: {
        body: {
          request_id: body.request_id,
          source_document_id: body.source_document_id,
          expected_version: body.expected_version,
          target: body.target,
        },
        location: data.location,
        resolution: data.resolution,
      },
      error: null,
    };
  } catch {
    return {
      journal: null,
      error: '无法读取本标签页保存的用途请求。原记录已保留，暂不发送新请求。',
    };
  }
}

function save(id: string, journal: Journal) {
  const raw = JSON.stringify(journal);
  sessionStorage.setItem(key(id), raw);
  if (sessionStorage.getItem(key(id)) !== raw) throw new Error('request not retained');
}

function matches(receipt: Receipt, id: string, body: PurposeInput) {
  return (
    receipt.session_id === id &&
    receipt.policy_committed === true &&
    receipt.input.request_id === body.request_id &&
    receipt.input.source_document_id === body.source_document_id &&
    receipt.input.expected_version === body.expected_version &&
    receipt.input.target === body.target
  );
}

function usable(current: Current | undefined): current is Current {
  return (
    !!current &&
    !!current.source_document_id &&
    Number.isInteger(current.version) &&
    current.version >= 0 &&
    ['allow', 'answer_only', 'crisis'].includes(current.policy)
  );
}

/** Owns only this consumer's immutable request and recovery, never downstream stop/repair policy. */
export function usePurposeChange(sessionId: string) {
  const qc = useQueryClient();
  const rereadRecording = () => {
    void qc.invalidateQueries({ queryKey: recordKeys.session(sessionId) });
    void qc.invalidateQueries({ queryKey: recordKeys.history(sessionId) });
    void qc.invalidateQueries({ queryKey: recordKeys.list });
  };
  const [initial] = useState(() => restore(sessionId));
  const [journal, setJournal] = useState(initial.journal);
  const journalRef = useRef(initial.journal);
  const [storageError, setStorageError] = useState(initial.error);
  const [selection, setSelection] = useState<{
    target: PurposeInput['target'];
    source: Current;
  } | null>(null);
  const [posted, setPosted] = useState<Receipt | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [sending, setSending] = useState(false);
  const currentRead = useQuery({
    queryKey: ['record', 'purpose-current', sessionId],
    queryFn: () => getPurposeImpact(sessionId),
    placeholderData: () => undefined,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const impactRead = useQuery({
    queryKey: ['record', 'purpose-request', sessionId, journal?.body.request_id ?? null],
    queryFn: () => {
      if (!journal) throw new Error('missing request');
      return getPurposeImpact(sessionId, journal.body.request_id, journal.location);
    },
    enabled: !!journal && journal.resolution === 'open' && !sending,
    placeholderData: () => undefined,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const received = impactRead.data?.receipt;
  const mismatch = !!received && !!journal && !matches(received, sessionId, journal.body);
  const receipt = journal
    ? received && !mismatch
      ? received
      : posted && matches(posted, sessionId, journal.body)
        ? posted
        : null
    : null;
  const unresolved = !!journal && journal.resolution === 'open' && !receipt;
  const current = currentRead.data?.current;
  const currentReady = usable(current) && !currentRead.isError && !currentRead.isFetching;
  const choiceChanged =
    !!selection &&
    (!current ||
      selection.source.source_document_id !== current.source_document_id ||
      selection.source.version !== current.version ||
      selection.source.policy !== current.policy);
  const canChoose =
    currentReady &&
    current.policy !== 'crisis' &&
    !sending &&
    !unresolved &&
    !mismatch &&
    !storageError;

  const publish = (next: Journal) => {
    save(sessionId, next);
    journalRef.current = next;
    setJournal(next);
  };
  const send = async (attempt: Journal) => {
    if (busyRef.current || storageError) return;
    busyRef.current = true;
    setSending(true);
    setProblem(null);
    try {
      // Persist before any request: a lost response must never leave an unrepeatable command.
      try {
        publish(attempt);
      } catch {
        setStorageError('浏览器无法保留恢复信息，本次没有发送。请保留当前标签页。');
        return;
      }
      setSelection(null);
      const result = await changePurpose(sessionId, attempt.body);
      if (!matches(result.receipt, sessionId, attempt.body))
        throw new Error('receipt identity mismatch');
      setPosted(result.receipt);
      publish({ ...attempt, location: result.location });
    } catch (error) {
      const conflict =
        error instanceof ApiError &&
        error.status === 409 &&
        (error.code === 'purpose_source_conflict' || error.code === 'purpose_version_conflict');
      const refused = error instanceof ApiError && (error.status === 400 || error.status === 422);
      if (conflict || refused) {
        try {
          publish({ ...attempt, resolution: conflict ? 'conflict' : 'refused' });
        } catch {
          setStorageError('无法保存这次拒绝结果，原请求仍保留；请先核对恢复记录。');
        }
        setProblem(
          conflict
            ? '来源或版本已变化。只有重新读取成功后，才能再次选择用途。'
            : '这次用途变更被拒绝。请查看当前政策和限制后重新决定。',
        );
      } else {
        setProblem(
          error instanceof ApiError && error.code === 'purpose_request_conflict'
            ? '请求身份与已有输入冲突。保留原请求，先核对原回执。'
            : '尚不能确认用途变更结果。保留原请求，先读取回执。',
        );
      }
    } finally {
      busyRef.current = false;
      setSending(false);
      void currentRead.refetch();
      rereadRecording();
    }
  };

  const confirm = () => {
    if (!canChoose || !selection || choiceChanged || busyRef.current) return;
    const body: PurposeInput = {
      request_id: randomId(),
      source_document_id: selection.source.source_document_id,
      expected_version: selection.source.version,
      target: selection.target,
    };
    setPosted(null);
    void send({ body, location: purposeLocation(sessionId, body.request_id), resolution: 'open' });
  };
  const refresh = () => {
    if (busyRef.current) return;
    const saved = restore(sessionId);
    if (saved.error) {
      setStorageError(saved.error);
      return;
    }
    if (saved.journal?.body.request_id === journalRef.current?.body.request_id) {
      journalRef.current = saved.journal;
      setJournal(saved.journal);
    }
    void currentRead.refetch();
    rereadRecording();
    if (journalRef.current?.resolution === 'open') void impactRead.refetch();
  };
  const retrySame = () => {
    const original = journalRef.current;
    if (
      original?.resolution !== 'open' ||
      !unresolved ||
      mismatch ||
      impactRead.isFetching ||
      !impactRead.isFetched ||
      storageError
    )
      return;
    void send(original);
  };
  return {
    current,
    currentReady,
    currentError: currentRead.isError,
    currentLoading: currentRead.isPending,
    journal,
    receipt,
    impact: mismatch ? undefined : impactRead.data,
    impactError: impactRead.isError,
    receiptMissing: unresolved && !impactRead.isFetching && (impactRead.isError || !received),
    reading: currentRead.isFetching || impactRead.isFetching,
    sending,
    unresolved,
    mismatch,
    storageError,
    problem:
      problem ??
      (journal?.resolution === 'conflict'
        ? '原请求因来源或版本变化被拒绝，请重新选择。'
        : journal?.resolution === 'refused'
          ? '原请求已被拒绝，请查看当前限制后重新决定。'
          : null),
    selection,
    choiceChanged,
    canChoose,
    canConfirm: canChoose && !!selection && !choiceChanged,
    canRetry:
      unresolved &&
      !mismatch &&
      !sending &&
      !storageError &&
      !impactRead.isFetching &&
      impactRead.isFetched,
    choose: (target: PurposeInput['target']) => {
      if (canChoose) setSelection({ target, source: current });
    },
    confirm,
    refresh,
    retrySame,
  };
}
