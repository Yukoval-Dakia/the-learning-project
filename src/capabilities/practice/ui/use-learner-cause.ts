import { useRef, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import type { Action, CauseEditor, Notice } from '@/ui-next/practice-studio/contracts';
import {
  type AttemptCauseOptions,
  type AttemptCauseWrite,
  getAttemptCauseOptions,
  setAttemptCause,
} from './practice-api';

type CurrentCause = NonNullable<AttemptCauseOptions['current']>;
type CauseOption = AttemptCauseOptions['options'][number];
type SavedCause = AttemptCauseWrite['cause'];

export interface LearnerCauseSeed {
  attemptEventId: string;
  current?: {
    source: 'user' | 'agent';
    primary_category: string;
    label: string;
    note?: string | null;
  } | null;
}

export interface LearnerCauseClient {
  getAttemptCauseOptions: typeof getAttemptCauseOptions;
  setAttemptCause: typeof setAttemptCause;
}

const learnerCauseClient: LearnerCauseClient = {
  getAttemptCauseOptions,
  setAttemptCause,
};

type EntryStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'saved' | 'readonly' | 'failed';

interface Entry {
  status: EntryStatus;
  options: readonly CauseOption[];
  current: CurrentCause | null;
  selected: string | null;
  note: string;
  noteKnown: boolean;
  reason?: string;
  notice?: Notice;
  noticeTone?: CauseEditor['noticeTone'];
}

function initialState(target: LearnerCauseSeed): Entry {
  return {
    status: 'idle',
    options: [],
    current: target.current ?? null,
    selected: target.current?.primary_category ?? null,
    note: target.current?.note ?? '',
    noteKnown: target.current?.note !== undefined,
  };
}

function wouldDropUnknownNote(entry: Entry): boolean {
  return entry.current?.source === 'user' && !entry.noteKnown && entry.note.trim().length === 0;
}

function causeError(error: unknown): { status: EntryStatus; notice: Notice; reason?: string } {
  if (error instanceof ApiError && (error.status === 404 || error.code === 'cause_not_available')) {
    return {
      status: 'readonly',
      reason: error.message || '这条作答现在不能补错因。',
      notice: {
        title:
          error.code === 'cause_not_available' ? error.message : '这条作答记录已经不能补错因。',
      },
    };
  }
  return {
    status: 'failed',
    notice: {
      title: '这次没读成，也没有改掉原来的原因。',
      detail: error instanceof Error ? error.message : undefined,
    },
  };
}

function writeError(error: unknown): { status: EntryStatus; notice: Notice } {
  if (error instanceof ApiError && (error.status === 404 || error.code === 'cause_not_available')) {
    return {
      status: 'readonly',
      notice: {
        title:
          error.code === 'cause_not_available' ? error.message : '这条作答记录已经不能补错因。',
      },
    };
  }
  return {
    status: 'failed',
    notice: {
      title: '这次没有记上，你选的原因和备注还在。',
      detail: error instanceof Error ? error.message : undefined,
    },
  };
}

/**
 * Owner seam for learner attribution. The practice routes decide eligibility, the catalogue,
 * effective source and receipt; this hook only keeps per-attempt input and invokes those routes.
 */
export function useLearnerCause(
  onSaved?: (attemptEventId: string, cause: SavedCause) => void,
  client: LearnerCauseClient = learnerCauseClient,
) {
  const [entries, setEntries] = useState<Readonly<Record<string, Entry>>>({});
  const reads = useRef(new Map<string, Promise<AttemptCauseOptions>>());
  const writes = useRef(new Set<string>());

  const load = (target: LearnerCauseSeed) => {
    const id = target.attemptEventId;
    const inFlight = reads.current.get(id);
    if (inFlight) return;
    const request = client.getAttemptCauseOptions(id);
    reads.current.set(id, request);
    setEntries((previous) => ({
      ...previous,
      [id]: {
        ...(previous[id] ?? initialState(target)),
        status: 'loading',
        reason: '正在读取可以选的原因。',
        notice: undefined,
      },
    }));
    request.then(
      (response) => {
        setEntries((previous) => {
          const prior = previous[id] ?? initialState(target);
          const selected =
            prior.selected && response.options.some((option) => option.id === prior.selected)
              ? prior.selected
              : (response.current?.primary_category ?? null);
          return {
            ...previous,
            [id]: {
              ...prior,
              status: 'ready',
              options: response.options,
              current: response.current,
              selected,
              noteKnown: response.current !== null && prior.noteKnown,
              reason: response.options.length > 0 ? undefined : '这个科目现在还没有可选的错因。',
            },
          };
        });
      },
      (error: unknown) => {
        const failure = causeError(error);
        setEntries((previous) => ({
          ...previous,
          [id]: {
            ...(previous[id] ?? initialState(target)),
            ...failure,
          },
        }));
      },
    );
    const clear = () => {
      if (reads.current.get(id) === request) reads.current.delete(id);
    };
    void request.then(clear, clear);
  };

  const save = (target: LearnerCauseSeed) => {
    const id = target.attemptEventId;
    const entry = entries[id] ?? initialState(target);
    if (writes.current.has(id)) return;
    if (
      !entry.selected ||
      entry.status === 'saving' ||
      entry.status === 'readonly' ||
      entry.status === 'saved'
    ) {
      return;
    }
    const note = entry.note.trim();
    if (wouldDropUnknownNote(entry)) {
      return;
    }
    if (
      entry.current?.source === 'user' &&
      entry.selected === entry.current.primary_category &&
      entry.noteKnown &&
      note.length === 0
    ) {
      return;
    }
    writes.current.add(id);
    setEntries((previous) => ({
      ...previous,
      [id]: { ...entry, status: 'saving', notice: undefined },
    }));
    client
      .setAttemptCause(id, {
        primary_category: entry.selected,
        user_notes: note.length > 0 ? entry.note : null,
      })
      .then(
        (response) => {
          setEntries((previous) => ({
            ...previous,
            [id]: {
              ...entry,
              status: 'saved',
              current: {
                source: response.cause.source,
                primary_category: response.cause.primary_category,
                label: response.cause.label,
              },
              selected: response.cause.primary_category,
              note: response.cause.user_notes ?? '',
              noteKnown: true,
              notice: {
                title: '已经记下这个原因。',
                detail: '之后会按你选的这个原因帮你安排相关练习。',
              },
              noticeTone: 'saved',
            },
          }));
          onSaved?.(id, response.cause);
          writes.current.delete(id);
        },
        (error: unknown) => {
          const failure = writeError(error);
          setEntries((previous) => ({
            ...previous,
            [id]: {
              ...entry,
              ...failure,
              noticeTone: 'error',
            },
          }));
          writes.current.delete(id);
        },
      );
  };

  const editorFor = (target: LearnerCauseSeed): CauseEditor => {
    const id = target.attemptEventId;
    const seed = initialState(target);
    const entry = entries[id] ?? seed;
    const canSubmit =
      entry.selected !== null &&
      entry.status !== 'loading' &&
      entry.status !== 'saving' &&
      entry.status !== 'readonly' &&
      entry.status !== 'saved' &&
      !wouldDropUnknownNote(entry) &&
      !(
        entry.current?.source === 'user' &&
        entry.selected === entry.current.primary_category &&
        entry.noteKnown &&
        entry.note.trim().length === 0
      );
    const saveAction: Action = {
      id: 'cause-save',
      label: entry.status === 'saving' ? '正在记下…' : '记下这个原因',
      availability: canSubmit
        ? { kind: 'enabled' }
        : entry.status === 'saving'
          ? { kind: 'busy', reason: '正在保存' }
          : {
              kind: 'disabled',
              reason: wouldDropUnknownNote(entry)
                ? '这条作答已有备注，但当前界面读不到；请重新写一句再保存，避免覆盖原备注。'
                : entry.current?.source === 'user' &&
                    entry.selected === entry.current.primary_category &&
                    entry.noteKnown &&
                    entry.note.trim().length === 0
                  ? '已经记的是这个原因；要修改可以另选一个原因或补充一句。'
                  : '先选一个原因。',
            },
    };
    const editAction: Action = {
      id: 'cause-edit',
      label: '继续修改',
      availability: { kind: 'enabled' },
    };
    const retryRead: Action = {
      id: 'cause-reload',
      label: '重新读取',
      availability: { kind: 'enabled' },
    };
    const actions =
      entry.status === 'loading' || entry.status === 'readonly'
        ? []
        : entry.status === 'saved'
          ? [editAction]
          : entry.status === 'failed' && entry.options.length === 0
            ? [retryRead]
            : [saveAction];
    return {
      current: entry.current ? { source: entry.current.source, label: entry.current.label } : null,
      options: entry.options,
      selected: entry.selected,
      note: entry.note,
      mode:
        entry.status === 'loading' || entry.status === 'saving'
          ? 'busy'
          : entry.status === 'saved'
            ? 'saved'
            : entry.status === 'readonly'
              ? 'readonly'
              : 'editable',
      reason: entry.reason,
      notice: entry.notice,
      noticeTone:
        entry.status === 'saved'
          ? 'saved'
          : entry.status === 'failed' || entry.status === 'readonly'
            ? 'error'
            : undefined,
      actions,
      onSelect: (optionId) => {
        setEntries((previous) => {
          const prior = previous[id] ?? seed;
          return {
            ...previous,
            [id]: {
              ...prior,
              status: prior.status === 'failed' ? 'ready' : prior.status,
              selected: optionId,
            },
          };
        });
      },
      onNoteChange: (value) => {
        setEntries((previous) => {
          const prior = previous[id] ?? seed;
          return {
            ...previous,
            [id]: {
              ...prior,
              status: prior.status === 'failed' ? 'ready' : prior.status,
              note: value,
            },
          };
        });
      },
      onToggle: (open) => {
        if (open && entry.status === 'idle' && !reads.current.has(id)) {
          load(target);
        }
      },
      onAction: (actionId) => {
        if (actionId === 'cause-save') save(target);
        else if (actionId === 'cause-reload') load(target);
        else if (actionId === 'cause-edit') {
          setEntries((previous) => {
            const prior = previous[id] ?? seed;
            return {
              ...previous,
              [id]: { ...prior, status: 'ready', notice: undefined },
            };
          });
        }
      },
    };
  };

  return { editorFor };
}
