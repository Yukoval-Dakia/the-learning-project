import { describe, expect, it } from 'vitest';

import { tasks } from '@/ai/registry';
import { noteGenerateTaskDefinition, noteVerifyTaskDefinition } from './note-tasks';

describe('Notes-owned task definitions', () => {
  it('projects the complete Notes definitions into the central registry', () => {
    expect(tasks.NoteGenerateTask).toBe(noteGenerateTaskDefinition);
    expect(tasks.NoteVerifyTask).toBe(noteVerifyTaskDefinition);
  });

  it('preserves provider, model, budgets and profile prompt builders', () => {
    expect(noteGenerateTaskDefinition).toMatchObject({
      kind: 'NoteGenerateTask',
      defaultProvider: 'xiaomi',
      defaultModel: 'mimo-v2.5-pro',
      budget: { maxIterations: 1, timeout: 90_000 },
      needsToolCall: false,
      isMultimodal: false,
      allowedTools: [],
      prompt: { kind: 'profile' },
    });
    expect(noteVerifyTaskDefinition).toMatchObject({
      kind: 'NoteVerifyTask',
      defaultProvider: 'xiaomi',
      defaultModel: 'mimo-v2.5-pro',
      budget: { maxIterations: 1, timeout: 60_000 },
      needsToolCall: false,
      isMultimodal: false,
      allowedTools: [],
      prompt: { kind: 'profile' },
    });
    expect(noteGenerateTaskDefinition.prompt.kind).toBe('profile');
    expect(noteVerifyTaskDefinition.prompt.kind).toBe('profile');
    if (noteGenerateTaskDefinition.prompt.kind !== 'profile') throw new Error('profile prompt');
    if (noteVerifyTaskDefinition.prompt.kind !== 'profile') throw new Error('profile prompt');
    expect(noteGenerateTaskDefinition.prompt.build).toBeInstanceOf(Function);
    expect(noteVerifyTaskDefinition.prompt.build).toBeInstanceOf(Function);
  });
});
