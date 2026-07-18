import { describe, expect, it } from 'vitest';
import { resolveInboxStatus } from './InboxPage';

describe('resolveInboxStatus', () => {
  it('keeps a partial-data diagnostic visible when every proposal lane is otherwise empty', () => {
    expect(
      resolveInboxStatus({
        loading: false,
        error: false,
        hasVisibleContent: false,
        hasDiagnostic: true,
      }),
    ).toBe('ok');
  });

  it('uses the cleared empty state only when data is complete and no content exists', () => {
    expect(
      resolveInboxStatus({
        loading: false,
        error: false,
        hasVisibleContent: false,
        hasDiagnostic: false,
      }),
    ).toBe('empty');
  });
});
