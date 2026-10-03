// Native pi presets own model identity, protocol, compat flags, authentication and headers.
// Keep this import lazy: the migration bundle externalizes the ESM-only pi packages.
export async function createLoomPiModels() {
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  return builtinModels();
}
