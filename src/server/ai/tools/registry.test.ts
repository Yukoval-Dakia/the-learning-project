import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, getTool, listTools, registerTool } from './registry';
import type { DomainTool } from './types';

function makeReadTool(name: string): DomainTool<{ q: string }, { hits: number }> {
  return {
    name,
    description: `Read tool ${name}`,
    effect: 'read',
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.object({ hits: z.number() }),
    costClass: 'local',
    async execute(_ctx, input) {
      return { hits: input.q.length };
    },
    summarize(input, output) {
      return `${name} · q=${input.q} · ${output.hits} hits`;
    },
    mirrorEvent: 'when_user_visible',
  };
}

function makeProposeTool(name: string): DomainTool<{ id: string }, { written: boolean }> {
  return {
    name,
    description: `Propose tool ${name}`,
    effect: 'propose',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ written: z.boolean() }),
    costClass: 'local',
    async execute(_ctx, _input) {
      return { written: true };
    },
    summarize(_input, _output) {
      return `${name} ok`;
    },
    mirrorEvent: 'always',
  };
}

describe('DomainTool registry', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('register + get round-trips a tool', () => {
    const t = makeReadTool('query_demo');
    registerTool(t);
    expect(getTool('query_demo')).toBe(t);
  });

  it('returns undefined for unknown tool names', () => {
    expect(getTool('nope')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    registerTool(makeReadTool('dup'));
    expect(() => registerTool(makeReadTool('dup'))).toThrow(/already registered/);
  });

  it('listTools with no filter returns all registered', () => {
    registerTool(makeReadTool('r1'));
    registerTool(makeReadTool('r2'));
    registerTool(makeProposeTool('p1'));
    expect(
      listTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['p1', 'r1', 'r2']);
  });

  it('listTools filters by effect', () => {
    registerTool(makeReadTool('r1'));
    registerTool(makeReadTool('r2'));
    registerTool(makeProposeTool('p1'));
    expect(
      listTools({ effect: 'read' })
        .map((t) => t.name)
        .sort(),
    ).toEqual(['r1', 'r2']);
    expect(listTools({ effect: 'propose' }).map((t) => t.name)).toEqual(['p1']);
    expect(listTools({ effect: 'write' })).toEqual([]);
  });
});
