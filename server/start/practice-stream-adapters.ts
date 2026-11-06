import { updateStartPracticeStreamItem } from './practice-stream-item-operation';
import { getStartPracticeStream } from './practice-stream-operation';
import { recomposeStartPracticeStream } from './practice-stream-recompose-operation';

// One family surface, constructed in the API graph when a Start operation first asks
// for it; each adapter keeps owning its own conversion, error and deadline handling.
export const practiceStreamAdapters = {
  getStartPracticeStream,
  recomposeStartPracticeStream,
  updateStartPracticeStreamItem,
};
