// Re-exported through FrontdoorContext['adapters'], so the API graph evaluates these
// modules: Start operations then share the hangar's registry, config snapshot and pool.
export { getStartPracticeStream } from './practice-stream-operation';
export { recomposeStartPracticeStream } from './practice-stream-recompose-operation';
export { updateStartPracticeStreamItem } from './practice-stream-item-operation';
