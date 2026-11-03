// YUK-1548 (§3.1/D3) — mermaid.parse under jsdom, worker-side only.
// Both modules are lazy dynamic imports: never loaded at module scope, never
// in the migrate bundle. First call pays ~570ms import + ~140MB RSS (measured
// in the design scratchpad); subsequent parses are ~3ms.

import type { BlockIssueT } from '@/core/schema/blocks';

interface MermaidParseError extends Error {
  hash?: {
    text?: string;
    token?: string;
    line?: number;
    loc?: {
      first_line?: number;
      last_line?: number;
      first_column?: number;
      last_column?: number;
    };
    expected?: string[];
  };
}

type MermaidModule = {
  initialize: (config: Record<string, unknown>) => void;
  parse: (source: string) => Promise<{ diagramType?: string }>;
};

let mermaidModule: Promise<MermaidModule> | undefined;

async function loadMermaid(): Promise<MermaidModule> {
  mermaidModule ??= (async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
    });
    // mermaid + DOMPurify resolve browser globals at import time.
    const g = globalThis as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.navigator = dom.window.navigator;
    g.DOMParser = dom.window.DOMParser;
    g.Element = dom.window.Element;
    g.Node = dom.window.Node;
    g.HTMLElement = dom.window.HTMLElement;
    g.SVGElement = dom.window.SVGElement;
    g.HTMLIFrameElement = dom.window.HTMLIFrameElement;
    const mermaid = (await import('mermaid')).default as unknown as MermaidModule;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return mermaid;
  })();
  return mermaidModule;
}

/** Parse via mermaid; syntax failures come back as diagram_parse_error issues. */
export async function parseMermaidSource(source: string): Promise<BlockIssueT[]> {
  let mermaid: MermaidModule;
  try {
    mermaid = await loadMermaid();
  } catch (error) {
    // Engine-level failure is not a model-repairable block problem.
    throw new Error(
      `mermaid runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await mermaid.parse(source);
    return [];
  } catch (error) {
    const hash = (error as MermaidParseError).hash;
    return [
      {
        code: 'diagram_parse_error',
        path: '/source',
        detail: `Mermaid could not parse the source: ${(error as MermaidParseError).message?.split('\n')[0] ?? 'parse error'}`,
        ...(hash?.loc?.first_line !== undefined || hash?.line !== undefined
          ? { line: hash?.loc?.first_line ?? hash?.line }
          : {}),
        ...(hash?.loc?.first_column !== undefined ? { column: hash.loc.first_column } : {}),
        ...(Array.isArray(hash?.expected) && hash.expected.length > 0
          ? { expected: hash.expected.slice(0, 12).map(String) }
          : {}),
      },
    ];
  }
}
