import { afterEach, expect, it, vi } from 'vitest';
import { projectionIsWriter, trackedFlagVector, warnFlipOrder } from './sot-flag';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('canonical writers cannot be disabled by retired environment values', () => {
  for (const [kind, flag] of [
    ['goal', 'PROJECTION_IS_WRITER_GOAL'],
    ['learning_item', 'PROJECTION_IS_WRITER_LEARNING_ITEM'],
    ['mistake_variant', 'PROJECTION_IS_WRITER_MISTAKE_VARIANT'],
  ] as const) {
    vi.stubEnv(flag, '0');
    expect(projectionIsWriter(kind)).toBe(true);
    expect(trackedFlagVector()[kind]).toBe(true);
  }
});
it('remaining flags stay isolated from canonical writers and from the knowledge flag', () => {
  vi.stubEnv('PROJECTION_IS_WRITER', '0');
  vi.stubEnv('PROJECTION_IS_WRITER_ARTIFACT', '1');
  vi.stubEnv('PROJECTION_IS_WRITER_ITEM_CALIBRATION', '0');
  expect(trackedFlagVector()).toMatchObject({
    artifact: true,
    item_calibration: false,
    goal: true,
    learning_item: true,
    'knowledge+knowledge_edge': false,
  });
});
it('artifact rollback warns without bricking either process; coherent policy prints only the vector', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('PROJECTION_IS_WRITER_ARTIFACT', '0');
  expect(() => warnFlipOrder()).not.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('previous release'));
  vi.stubEnv('PROJECTION_IS_WRITER_ARTIFACT', '1');
  warn.mockClear();
  warnFlipOrder();
  expect(warn).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledTimes(2);
});
