export type TaskJsonErrorFactory = (message: string, cause?: unknown) => Error;

export function parseTaskJsonObject(
  text: string,
  taskKind: string,
  makeError: TaskJsonErrorFactory,
): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw makeError(`${taskKind} output did not contain a JSON object`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw makeError(`${taskKind} output was not valid JSON`, error);
  }
}
