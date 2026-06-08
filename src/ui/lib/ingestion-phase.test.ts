import { describe, expect, it } from 'vitest';

import { derivePhaseFromEvents, latestProgress } from './ingestion-phase';

const ev = (event_type: string) => ({ event_type });

describe('derivePhaseFromEvents', () => {
  it('no terminal event → extracting (job still running)', () => {
    expect(
      derivePhaseFromEvents([
        ev('ingestion.uploaded'),
        ev('ingestion.queued'),
        ev('ingestion.extracting'),
        ev('ingestion.extraction_progress'),
        ev('ingestion.extraction_progress'),
      ]),
    ).toBe('extracting');
  });

  it('empty history → extracting', () => {
    expect(derivePhaseFromEvents([])).toBe('extracting');
  });

  it('extraction_completed in history → reviewing', () => {
    expect(
      derivePhaseFromEvents([
        ev('ingestion.extracting'),
        ev('ingestion.extraction_progress'),
        ev('ingestion.extraction_completed'),
      ]),
    ).toBe('reviewing');
  });

  it('extraction_failed in history → error', () => {
    expect(
      derivePhaseFromEvents([ev('ingestion.extracting'), ev('ingestion.extraction_failed')]),
    ).toBe('error');
  });

  it('imported in history → reviewing', () => {
    expect(
      derivePhaseFromEvents([
        ev('ingestion.extraction_completed'),
        ev('ingestion.reviewed'),
        ev('ingestion.imported'),
      ]),
    ).toBe('reviewing');
  });

  it('completed then later failed (defensive) → last terminal wins (error)', () => {
    expect(
      derivePhaseFromEvents([
        ev('ingestion.extraction_completed'),
        ev('ingestion.extraction_failed'),
      ]),
    ).toBe('error');
  });
});

describe('latestProgress', () => {
  it('no progress events → null', () => {
    expect(latestProgress([{ event_type: 'ingestion.extracting', payload: {} }])).toBeNull();
  });

  it('picks the latest valid progress payload', () => {
    expect(
      latestProgress([
        {
          event_type: 'ingestion.extraction_progress',
          payload: { done: 1, total: 3, stage: 'ocr' },
        },
        {
          event_type: 'ingestion.extraction_progress',
          payload: { done: 2, total: 3, stage: 'ocr' },
        },
        {
          event_type: 'ingestion.extraction_progress',
          payload: { done: 3, total: 3, stage: 'structure' },
        },
      ]),
    ).toEqual({ done: 3, total: 3, stage: 'structure' });
  });

  it('ignores malformed payloads (missing/zero total)', () => {
    expect(
      latestProgress([
        { event_type: 'ingestion.extraction_progress', payload: { done: 1, total: 0 } },
        { event_type: 'ingestion.extraction_progress', payload: { done: 1 } },
      ]),
    ).toBeNull();
  });
});
