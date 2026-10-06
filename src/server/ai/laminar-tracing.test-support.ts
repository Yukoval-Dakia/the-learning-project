import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { TraceExporter } from './laminar-tracing';

export interface TraceRecord {
  name: string;
  context: string;
  parent?: string;
  type: string;
  attributes: Record<string, string | number | boolean>;
  ends: number;
  status?: number;
}

export function memoryTraceExporter() {
  const records: TraceRecord[] = [];
  const exporter: TraceExporter = {
    start: (options) => {
      const record: TraceRecord = {
        name: options.name,
        context: `span-${records.length}`,
        parent: options.parentContext,
        type: options.spanType,
        attributes: {},
        ends: 0,
      };
      records.push(record);
      return {
        context: record.context,
        setAttribute: (name, value) => {
          record.attributes[name] = value;
        },
        setInput: (value) => {
          record.attributes['lmnr.span.input'] = JSON.stringify(value);
        },
        setOutput: (value) => {
          record.attributes['lmnr.span.output'] = JSON.stringify(value);
        },
        setStatus: (status) => {
          record.status = status.code;
        },
        end: () => {
          record.ends += 1;
        },
      };
    },
    flush: async () => {},
  };
  return { records, exporter };
}

export const traceField = (key: string) => `lmnr.association.properties.metadata.${key}`;

// Numeric usage from immutable synth-18/30 runtime artifacts, plus boundary cases.
// Cache-write coverage is synthetic; the captured calls reported no cache writes.
export const piTraceUsageCases = [
  {
    name: 'captured synth-18',
    input: 62,
    output: 336,
    cacheRead: 2432,
    cacheWrite: 0,
    totalTokens: 2830,
    totalCost: 0.000328106,
    observed: true,
    totalInput: 2494,
  },
  {
    name: 'captured synth-30',
    input: 110,
    output: 104,
    cacheRead: 2432,
    cacheWrite: 0,
    totalTokens: 2646,
    totalCost: 0.00014714600000000002,
    observed: true,
    totalInput: 2542,
  },
  {
    name: 'mixed cache read and write',
    input: 7,
    output: 5,
    cacheRead: 11,
    cacheWrite: 13,
    totalTokens: 36,
    totalCost: 0.025,
    observed: true,
    totalInput: 31,
  },
  {
    name: 'cache write only',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 13,
    totalTokens: 13,
    totalCost: 0.001,
    observed: true,
    totalInput: 13,
  },
  {
    name: 'explicit zero',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    observed: true,
    totalInput: 0,
  },
  {
    name: 'unknown',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    observed: false,
    totalInput: undefined,
  },
];

export function piTraceUsage(
  fixture: (typeof piTraceUsageCases)[number],
): AssistantMessage['usage'] {
  return {
    input: fixture.input,
    output: fixture.output,
    cacheRead: fixture.cacheRead,
    cacheWrite: fixture.cacheWrite,
    totalTokens: fixture.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: fixture.totalCost },
  };
}
