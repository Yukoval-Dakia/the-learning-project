import { expect, it } from 'vitest';
import { parseEvent } from './index';

const base = {
  actor_kind: 'system',
  actor_ref: 'learning-item-attribution-repair',
  action: 'experimental:learning_item_knowledge_ids_rewrite',
  subject_kind: 'learning_item',
  subject_id: 'item',
  outcome: 'success',
  payload: { from_id: 'from', into_id: 'winner' },
};

it('accepts only a typed, nonempty attribution mapping through the real event parser', () => {
  expect(parseEvent(base).payload).toEqual(base.payload);
  for (const payload of [
    { from_id: 'same', into_id: 'same' },
    { from_id: '' },
    { from_id: 'from', into_id: 'winner', title: 'illegal structural overwrite' },
  ]) {
    expect(() => parseEvent({ ...base, payload })).toThrow();
  }
  expect(() => parseEvent({ ...base, actor_kind: 'agent' })).toThrow();
});

it('restoration requires an exact prior state and cannot fall through the generic event parser', () => {
  const restore = {
    ...base,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:learning_item_state_restore',
    caused_by_event_id: 'proposal',
    payload: { expected_status: 'in_progress', status: 'resting', completed_at: null },
  };
  expect(parseEvent(restore).payload).toEqual(restore.payload);
  for (const payload of [
    { ...restore.payload, status: 'invented' },
    { ...restore.payload, expected_status: 'pending' },
    { ...restore.payload, completed_at: 'not-a-date' },
    { ...restore.payload, version: 100 },
  ])
    expect(() => parseEvent({ ...restore, payload })).toThrow();
  expect(() => parseEvent({ ...restore, caused_by_event_id: '' })).toThrow();
});
