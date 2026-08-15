import { describe, expect, it } from 'vitest';

import { tasks } from '@/ai/registry';
import { noteRefineTaskSpec, parseNoteRefineOutput } from './note-refine';
import { noteGenerateTaskSpec, noteVerifyTaskSpec } from './note-tasks';

describe('Notes-owned task definitions', () => {
  it('projects the complete Notes definitions into the central registry', () => {
    expect(tasks.NoteGenerateTask).toBe(noteGenerateTaskSpec.definition);
    expect(tasks.NoteRefineTask).toBe(noteRefineTaskSpec.definition);
    expect(tasks.NoteVerifyTask).toBe(noteVerifyTaskSpec.definition);
  });

  it('preserves provider, model, budgets and profile prompt builders', () => {
    expect(noteGenerateTaskSpec.definition).toMatchObject({
      kind: 'NoteGenerateTask',
      defaultProvider: 'xiaomi',
      defaultModel: 'mimo-v2.5-pro',
      budget: { maxIterations: 1, timeout: 90_000 },
      needsToolCall: false,
      isMultimodal: false,
      allowedTools: [],
      prompt: { kind: 'profile' },
    });
    expect(noteVerifyTaskSpec.definition).toMatchObject({
      kind: 'NoteVerifyTask',
      defaultProvider: 'xiaomi',
      defaultModel: 'mimo-v2.5-pro',
      budget: { maxIterations: 1, timeout: 60_000 },
      needsToolCall: false,
      isMultimodal: false,
      allowedTools: [],
      prompt: { kind: 'profile' },
    });
    expect(noteRefineTaskSpec.definition).toMatchObject({
      kind: 'NoteRefineTask',
      defaultProvider: 'xiaomi',
      defaultModel: 'mimo-v2.5-pro',
      budget: { maxIterations: 1, timeout: 60_000 },
      needsToolCall: false,
      isMultimodal: false,
      allowedTools: [],
      prompt: { kind: 'profile' },
    });
    expect(noteGenerateTaskSpec.definition.prompt.kind).toBe('profile');
    expect(noteRefineTaskSpec.definition.prompt.kind).toBe('profile');
    expect(noteVerifyTaskSpec.definition.prompt.kind).toBe('profile');
    if (noteGenerateTaskSpec.definition.prompt.kind !== 'profile')
      throw new Error('profile prompt');
    if (noteRefineTaskSpec.definition.prompt.kind !== 'profile') throw new Error('profile prompt');
    if (noteVerifyTaskSpec.definition.prompt.kind !== 'profile') throw new Error('profile prompt');
    expect(noteGenerateTaskSpec.definition.prompt.build).toBeInstanceOf(Function);
    expect(noteRefineTaskSpec.definition.prompt.build).toBeInstanceOf(Function);
    expect(noteRefineTaskSpec.parseText).toBe(parseNoteRefineOutput);
    expect(noteVerifyTaskSpec.definition.prompt.build).toBeInstanceOf(Function);
  });
});
