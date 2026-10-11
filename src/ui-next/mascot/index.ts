// The mascot (B1–B4). three.js is not imported from here: MascotLayer loads ./flower-gl lazily.
export type { MascotController } from './controller';
export { FlowerStill } from './FlowerStill';
export { MASCOT_CANVAS, type MascotMode } from './MascotLayer';
export {
  type MascotActivity,
  MascotDock,
  MascotProvider,
  type MascotProviderProps,
  MascotSlot,
  type MascotSlotProps,
  useMascot,
  useMascotActivity,
} from './MascotProvider';
export { LIMIT as MASCOT_LIMIT, type Orientation } from './orientation';
export { type MascotRender, type MascotSupport, type StillReason, mascotSupport } from './support';
