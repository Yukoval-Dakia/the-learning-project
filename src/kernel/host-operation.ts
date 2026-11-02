/**
 * Thrown when a kernel port is used before its owning capability installed it at
 * startup. This is a wiring defect in the host, not a transient read failure, so
 * callers that degrade on errors must rethrow it rather than hide it.
 */
export class HostOperationNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostOperationNotInstalledError';
  }
}
