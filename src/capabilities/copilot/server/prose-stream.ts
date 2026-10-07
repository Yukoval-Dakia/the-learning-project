/** Protocol comments can span provider deltas. Keep their JSON out of public job events. */
export function createCopilotProseStream(emit: (text: string) => void) {
  let pending = '';
  let inComment = false;
  let quoted = false;
  let escaped = false;
  const open = '<!--';
  const close = '-->';

  function push(text: string) {
    pending += text;
    while (pending.length > 0) {
      if (inComment) {
        let index = 0;
        for (; index < pending.length; index += 1) {
          const char = pending[index];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') {
            quoted = true;
          } else if (pending.startsWith(close, index)) {
            pending = pending.slice(index + close.length);
            inComment = false;
            break;
          } else if (close.startsWith(pending.slice(index))) {
            // A closing delimiter split across provider chunks.
            break;
          }
        }
        if (!inComment) continue;
        pending = pending.slice(index);
        break;
      }
      const delimiter = open;
      const at = pending.indexOf(delimiter);
      if (at !== -1) {
        if (at > 0) emit(pending.slice(0, at));
        pending = pending.slice(at + delimiter.length);
        inComment = true;
        continue;
      }
      // Only a delimiter prefix needs buffering; even a long marker is discarded incrementally.
      let held = Math.min(delimiter.length - 1, pending.length);
      while (held > 0 && !pending.endsWith(delimiter.slice(0, held))) held -= 1;
      if (pending.length > held) emit(pending.slice(0, pending.length - held));
      pending = held > 0 ? pending.slice(-held) : '';
      break;
    }
  }

  function finish() {
    if (!inComment && pending) emit(pending);
    pending = '';
    inComment = false;
    quoted = false;
    escaped = false;
  }

  return { push, finish };
}

/** Also removes legacy learning/presentation comments without interpreting their content. */
export function stripCopilotInternalComments(text: string): string {
  let visible = '';
  const stream = createCopilotProseStream((chunk) => {
    visible += chunk;
  });
  stream.push(text);
  stream.finish();
  return visible === text ? text : visible.trimEnd();
}
