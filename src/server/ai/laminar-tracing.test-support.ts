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
