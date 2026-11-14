import { describe, expect, it } from 'vitest';
import {
  HostOperationConflictError,
  installHostOperation,
  installedHostOperation,
  runHostOperationInstallation,
} from './host-operation';

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
});
