// YUK-1548 adversarial acceptance — direct compose_block calls.
import { composeBlockTool } from '../src/capabilities/copilot/server/tools/compose-block';
import { db } from '../src/db/client';
import type { ToolContext } from '../src/kernel/tools/types';

const ctx = {
  db,
  callerActor: { kind: 'agent', ref: 'copilot' },
  taskRunId: 'yuk1548-adversarial-2',
  logTaskRunId: 'yuk1548-adversarial-2',
  signal: new AbortController().signal,
} as unknown as ToolContext;

const base = { v: 1, alt: 'adversarial figure' };
const svgWrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;

const cases: [string, unknown][] = [
  ['svg <script>', { ...base, kind: 'figure', svg: svgWrap('<script>alert(1)</script>') }],
  [
    'svg foreignObject',
    {
      ...base,
      kind: 'figure',
      svg: svgWrap(
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>',
      ),
    },
  ],
  [
    'svg external href',
    { ...base, kind: 'figure', svg: svgWrap('<use href="https://evil.example/x.svg#y"/>') },
  ],
  [
    'svg on* handler',
    {
      ...base,
      kind: 'figure',
      svg: svgWrap('<rect x="0" y="0" width="1" height="1" onclick="alert(1)"/>'),
    },
  ],
  [
    'svg comment',
    { ...base, kind: 'figure', svg: svgWrap('<!-- sneaky <script> -->') },
  ],
  [
    'svg text outside root',
    { ...base, kind: 'figure', svg: `hello${svgWrap('')}` },
  ],
  [
    'mermaid click',
    {
      ...base,
      kind: 'diagram',
      engine: 'mermaid',
      source: 'flowchart TD\n  A[x] --> B[y]\n  click A "https://evil.example"',
    },
  ],
  [
    'mermaid %%{init}',
    {
      ...base,
      kind: 'diagram',
      engine: 'mermaid',
      source: '%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\nflowchart TD\n  A --> B',
    },
  ],
];

for (const [label, block] of cases) {
  const out = await composeBlockTool.execute(ctx, { block } as never);
  console.log(`=== ${label}\n${JSON.stringify(out).slice(0, 320)}`);
}
process.exit(0);
