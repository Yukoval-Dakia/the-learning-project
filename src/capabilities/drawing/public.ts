// drawing.public — the cross-capability entry point. compose_block reaches the
// request through the kernel port installed by installDrawingHostOperations()
// at host startup; nothing else imports the package internals.
import { installDrawingRequestPort } from '@/kernel/tools/drawing-request';
import { requestDrawing } from './server/drawing-service';

export {
  DRAWING_JOB_NAME,
  type DrawingBlockIssue,
  type DrawingBoss,
  type DrawingRequestOutcome,
  type DrawingStatusView,
  requestDrawing,
} from './server/drawing-service';

/** Boot wiring: API, Start acceptance and worker hosts each install once. */
export function installDrawingHostOperations(): void {
  installDrawingRequestPort(requestDrawing);
}
