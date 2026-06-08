import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExtractionProgressBar } from './VisionTab';

// Bug A (fix-docx-ingestion): static render of the extraction progress bar.

const progress = (done: number, total: number, stage?: string) => ({
  event_type: 'ingestion.extraction_progress',
  payload: stage ? { done, total, stage } : { done, total },
});

describe('ExtractionProgressBar', () => {
  it('shows an indeterminate "等待 worker" line before any progress event', () => {
    const html = renderToString(
      <ExtractionProgressBar events={[{ event_type: 'ingestion.extracting', payload: {} }]} />,
    );
    expect(html).toContain('等待 worker');
  });

  it('renders OCR stage with N / M and a determinate fill width', () => {
    const html = renderToString(
      <ExtractionProgressBar events={[progress(1, 3, 'ocr'), progress(2, 3, 'ocr')]} />,
    );
    expect(html).toContain('OCR');
    // React inserts comment markers between adjacent text nodes; assert the
    // pieces rather than the joined "2 / 3" string.
    expect(html).toContain('>2<');
    expect(html).toContain('>3<');
    // 2/3 → 67%
    expect(html).toContain('width:67%');
  });

  it('renders structure stage label at full width', () => {
    const html = renderToString(<ExtractionProgressBar events={[progress(3, 3, 'structure')]} />);
    expect(html).toContain('结构化中');
    expect(html).toContain('>3<');
    expect(html).toContain('width:100%');
  });
});
