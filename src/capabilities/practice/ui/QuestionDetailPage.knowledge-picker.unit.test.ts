import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src/capabilities/practice/ui/QuestionDetailPage.tsx'),
  'utf8',
);

describe('QuestionDetailPage knowledge picker', () => {
  it('loads options only after the picker opens', () => {
    const queryStart = source.indexOf('const knowledgeOptionsQ = useQuery({');
    const querySource = source.slice(queryStart, queryStart + 240);

    expect(queryStart).toBeGreaterThanOrEqual(0);
    expect(querySource).toContain('enabled: showAddChip');
  });

  it('keeps loading and failure recovery visible without a hover-only explanation', () => {
    const pickerStart = source.indexOf('{showAddChip && knowledgeOptionsQ.data ? (');
    const pickerSource = source.slice(pickerStart, pickerStart + 3_500);

    expect(pickerStart).toBeGreaterThanOrEqual(0);
    expect(pickerSource).toContain('正在加载知识点…');
    expect(pickerSource).toContain('role="alert"');
    expect(pickerSource).toContain('知识点列表加载失败');
    expect(pickerSource).toContain("knowledgeOptionsQ.isFetching ? '重新加载…' : '重试'");
    expect(pickerSource.match(/>\s*取消\s*</g)).toHaveLength(2);
    expect(pickerSource).not.toContain(
      'disabled={knowledgeOptionsQ.isLoading || knowledgeOptionsQ.isError}',
    );
    expect(pickerSource).not.toContain('title={');
    expect(pickerSource.indexOf('knowledgeOptionsQ.data ?')).toBeLessThan(
      pickerSource.indexOf('knowledgeOptionsQ.isError ?'),
    );
  });
});
