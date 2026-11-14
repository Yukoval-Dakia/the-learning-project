import { describe, expect, it } from 'vitest';
import {
  HostOperationConflictError,
  installHostOperation,
  installedHostOperation,
  runHostOperationInstallation,
} from './host-operation';
import {
  batchConfirmEligibleKind,
  installBatchConfirmEligibleKinds,
} from './proposals/batch-confirm';

describe('host operation installation lifecycle', () => {
  // @invariant concurrency: one phase installs once, conflicting direct installs fail, and failed preparation can retry
  // @fails-if duplicate calls execute twice, silently overwrite a binding, or mark a failed phase ready
  it('keeps concurrent installation idempotent and failed preparation retryable', async () => {
    const owner = 'lifecycle-test-owner';
    let installCalls = 0;
    let releaseInstallation: () => void = () => undefined;
    const installationGate = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });

    const firstInstall = runHostOperationInstallation(owner, 'host', async () => {
      installCalls += 1;
      await installationGate;
      installHostOperation('lifecycle-test:operation', 'installed');
    });
    const concurrentInstall = runHostOperationInstallation(owner, 'host', async () => {
      installCalls += 1;
      installHostOperation('lifecycle-test:operation', 'installed');
    });
    releaseInstallation();
    await Promise.all([firstInstall, concurrentInstall]);

    expect(installCalls).toBe(1);
    expect(installedHostOperation('lifecycle-test:operation')).toBe('installed');
    expect(() => installHostOperation('lifecycle-test:operation', 'conflicting')).toThrow(
      HostOperationConflictError,
    );

    await expect(
      runHostOperationInstallation(owner, 'worker', async () => {
        installHostOperation('lifecycle-test:recover', 'partial');
        throw new Error('late install failure');
      }),
    ).rejects.toThrow('late install failure');
    expect(installedHostOperation('lifecycle-test:recover')).toBeUndefined();

    await runHostOperationInstallation(owner, 'worker', async () => {
      installHostOperation('lifecycle-test:recover', 'recovered');
    });
    expect(installedHostOperation('lifecycle-test:recover')).toBe('recovered');
  });

  // @invariant concurrency: repeated composition installs may allocate an equivalent binding without losing conflict detection
  // @fails-if reject a freshly allocated equivalent Set or accept a changed Set as the same implementation
  it('keeps repeated composition installation safe without hiding changed bindings', () => {
    const buildRegistry = () =>
      new Map([
        [
          'review_required',
          async (database: { value: string }, input: { proposalId: string }) => {
            await Promise.resolve(database);
            return input.proposalId;
          },
        ],
      ]);
    const firstRegistry = buildRegistry();
    const secondRegistry = buildRegistry();
    installHostOperation('lifecycle-test:equivalent', firstRegistry);
    installHostOperation('lifecycle-test:equivalent', secondRegistry);
    expect(installedHostOperation('lifecycle-test:equivalent')).toBe(firstRegistry);

    installBatchConfirmEligibleKinds(['review_required', 'correction']);
    installBatchConfirmEligibleKinds(['review_required', 'correction']);

    expect(batchConfirmEligibleKind('review_required')).toBe(true);
    expect(() => installBatchConfirmEligibleKinds(['review_required', 'withdrawal'])).toThrow(
      HostOperationConflictError,
    );
  });

  // @invariant concurrency: an equivalent reinstall never replaces the first captured host state
  // @fails-if return the later source-equivalent function so composition switches captured registries mid-process
  it('preserves the first operation when equivalent composition reentry allocates fresh state', () => {
    const firstState = new Set(['first']);
    const secondState = new Set(['second']);
    const buildReader = (state: Set<string>) => () => [...state];

    installHostOperation('lifecycle-test:captured-state', buildReader(firstState));
    installHostOperation('lifecycle-test:captured-state', buildReader(secondState));

    const readInstalled = installedHostOperation<() => string[]>('lifecycle-test:captured-state');
    expect(readInstalled?.()).toEqual(['first']);
  });
});
