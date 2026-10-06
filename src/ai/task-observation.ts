/** SDK-free observation seam. The server runner supplies the process implementation. */
export interface TaskOperationObservation {
  operation: 'run' | 'finalize';
  taskKind: string;
  taskRunId?: string;
  logicalRunId?: string;
}

export type TaskBusinessOutcome = 'accepted' | 'rejected' | 'cancelled';
type ReportOutcome = (outcome: TaskBusinessOutcome) => void;
export type TaskOperationObserver = <T>(
  observation: TaskOperationObservation,
  execute: (reportOutcome: ReportOutcome) => Promise<T>,
) => Promise<T>;

const unobserved: TaskOperationObserver = (_observation, execute) => execute(() => {});
let observer = unobserved;

/** Composition only: capabilities observe work without loading a server telemetry backend. */
export function installTaskOperationObserver(implementation: TaskOperationObserver): void {
  observer = implementation;
}

export function observeTaskOperation<T>(
  observation: TaskOperationObservation,
  execute: (reportOutcome: ReportOutcome) => Promise<T>,
): Promise<T> {
  return observer(observation, execute);
}
