// Which question images a learner may see. A photographed source page is a whole sheet:
// it carries other questions and their handwriting, so it is prompt material for vision
// models only. Learner reads must drop it instead of rendering it as this question's
// picture. Writers mark such rows with `metadata.prompt_images_are_source_pages`.

export const PROMPT_IMAGES_ARE_SOURCE_PAGES_KEY = 'prompt_images_are_source_pages' as const;

export function questionPromptImagesAreSourcePages(metadata: unknown): boolean {
  return (
    metadata != null &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>)[PROMPT_IMAGES_ARE_SOURCE_PAGES_KEY] === true
  );
}

/** `image_refs` minus whole source pages; verified figure crops are unaffected. */
export function learnerVisibleImageRefs(q: {
  image_refs?: readonly string[] | null;
  metadata?: unknown;
}): string[] {
  if (questionPromptImagesAreSourcePages(q.metadata)) return [];
  return [...(q.image_refs ?? [])];
}
