import { createHash } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { DraftFocus } from '@/core/schema/assessment/draft-focus';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import { QuestionGroupStructure } from '@/core/schema/assessment/structure';
import type { Db, Tx } from '@/db/client';
import {
  assessment_response_draft,
  type drawing,
  event,
  question,
  question_revision,
} from '@/db/schema';
import { getR2 } from '@/kernel/object-storage';
import { lineageQuestionIds } from '@/kernel/read-models/usage-policy';
import {
  createAssessmentAssetLoader,
  withinAssessmentSignal,
} from '@/kernel/records/assessment-assets';
import { withStudyAuthorization } from '@/kernel/records/hint-continuity';
import type { MultimodalTaskInput } from '@/server/ai/runner';
import type { DrawingImageManifestEntry } from '../tasks/drawing-task';

type ImageSource = Pick<typeof drawing.$inferSelect, 'session_id' | 'sources' | 'source_event_id'>;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class DrawingImageInputError extends Error {
  readonly code = 'source_image_unavailable';
  constructor(cause?: unknown) {
    super('原题图片的版本、公开范围或内容无法核验，这次绘图没有执行。', { cause });
    this.name = 'DrawingImageInputError';
  }
}

/** The accepted ask supplies coordinates; neither model arguments nor live figures supply pixels. */
export async function readDrawingImageManifest(
  db: Db | Tx,
  source: ImageSource,
  requireCurrentDraft = true,
): Promise<DrawingImageManifestEntry[]> {
  const [ask] = source.source_event_id
    ? await db.select().from(event).where(eq(event.id, source.source_event_id))
    : [];
  const raw = ask?.payload.draft_focus;
  const grant = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const parsed = DraftFocus.safeParse(
    grant && {
      question_id: grant.question_id,
      issuance_id: grant.issuance_id,
      revision_id: grant.revision_id,
      save_epoch: grant.save_epoch,
    },
  );
  const manifest: DrawingImageManifestEntry[] = [];
  let boundQuestionIds: string[] = [];
  if (raw !== undefined) {
    if (
      !ask ||
      !grant ||
      !parsed.success ||
      ask.session_id !== source.session_id ||
      ask.actor_kind !== 'user' ||
      ask.actor_ref !== 'user:self' ||
      ask.action !== 'experimental:copilot_user_ask' ||
      ask.payload.surface !== 'copilot' ||
      ask.payload.derivation_policy !== 'allow' ||
      !source.sources.some((s) => s.kind === 'question' && s.id === parsed.data.question_id)
    ) {
      throw new DrawingImageInputError();
    }
    const focus = parsed.data;
    try {
      const bound = await withStudyAuthorization(
        db,
        { issuanceId: focus.issuance_id, questionId: focus.question_id },
        async (tx, { issuance: issued, revision }, binding, sources, sourceEpochs) => {
          if (requireCurrentDraft) {
            // Freshness fences generation; published figures outlive subsequent answer edits.
            const [draft] = await tx
              .select({ save_epoch: assessment_response_draft.save_epoch })
              .from(assessment_response_draft)
              .where(eq(assessment_response_draft.issuance_id, focus.issuance_id))
              .for('share');
            if (draft?.save_epoch !== focus.save_epoch) throw new DrawingImageInputError();
          }
          if (
            revision.revision_id !== focus.revision_id ||
            grant.binding_digest !== binding ||
            grant.source_digest !== sources ||
            grant.source_usage_epochs === undefined ||
            canonicalHash(grant.source_usage_epochs) !== canonicalHash(sourceEpochs)
          )
            throw new DrawingImageInputError();
          const structure = QuestionGroupStructure.safeParse(revision.structure);
          if (
            !structure.success ||
            structure.data.group_id !== revision.group_id ||
            issued.part_ids.length === 0 ||
            issued.part_ids.some((id) => !structure.data.parts.some((p) => p.part_id === id)) ||
            (focus.question_id !== revision.group_id &&
              !issued.part_ids.includes(focus.question_id))
          ) {
            throw new DrawingImageInputError();
          }
          const parts = structure.data.parts.filter(
            (part) =>
              issued.part_ids.includes(part.part_id) &&
              (focus.question_id === revision.group_id || part.part_id === focus.question_id),
          );
          const materialIds = new Set(parts.flatMap((part) => part.material_ids));
          if (
            [...materialIds].some(
              (id) => !structure.data.materials.some((m) => m.material_id === id),
            )
          ) {
            throw new DrawingImageInputError();
          }
          for (const material of structure.data.materials) {
            if (
              !materialIds.has(material.material_id) ||
              material.kind !== 'figure' ||
              !isPublicSharedMaterial(material)
            ) {
              continue;
            }
            if (
              !/^sha256:[0-9a-f]{64}$/.test(material.asset.digest) ||
              !issued.material_bindings.some(
                (b) =>
                  b.material_id === material.material_id &&
                  b.asset_digest === material.asset.digest,
              )
            ) {
              throw new DrawingImageInputError();
            }
            manifest.push({
              ...focus,
              material_id: material.material_id,
              ...material.asset,
              contains_learner_handwriting: material.contains_learner_handwriting ?? 'unknown',
            });
          }
          for (const part of parts) {
            const surfaces = [
              part.prompt_md,
              ...structure.data.materials
                .filter(
                  (m) => part.material_ids.includes(m.material_id) && isPublicSharedMaterial(m),
                )
                .map((m) => m.content_md ?? ''),
            ];
            if (
              /!\[[^\]]*\]\(|<img\b|如图|见图|下图|图中|图所示/i.test(surfaces.join('\n')) &&
              !manifest.some((m) => part.material_ids.includes(m.material_id))
            ) {
              throw new DrawingImageInputError();
            }
          }
          return [revision.group_id, ...parts.map((part) => part.part_id)];
        },
      );
      boundQuestionIds = bound;
    } catch (error) {
      if (error instanceof DrawingImageInputError) throw error;
      throw new DrawingImageInputError(error);
    }
  }

  // Live columns are only a veto for unbound images, never a fallback source.
  const unbound = (await lineageQuestionIds(db, source.sources)).filter(
    (id) => !boundQuestionIds.includes(id),
  );
  if (unbound.length > 0) {
    const images = await db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          inArray(question.id, unbound),
          sql`(jsonb_array_length(${question.figures}) > 0 OR jsonb_array_length(${question.image_refs}) > 0)`,
        ),
      )
      .limit(1);
    const revisions = await db
      .select({ structure: question_revision.structure })
      .from(question_revision)
      .where(
        or(
          inArray(question_revision.group_id, unbound),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${question_revision.structure}->'parts') p
            WHERE p->>'part_id' IN (${sql.join(
              unbound.map((id) => sql`${id}`),
              sql`, `,
            )}))`,
        ),
      );
    if (
      images.length ||
      revisions.some((r) => {
        const parsedStructure = QuestionGroupStructure.safeParse(r.structure);
        return (
          !parsedStructure.success ||
          parsedStructure.data.materials.some(
            (m) => m.kind === 'figure' && isPublicSharedMaterial(m),
          )
        );
      })
    ) {
      throw new DrawingImageInputError();
    }
  }
  return manifest;
}

export async function loadDrawingImageBytes(
  db: Db | Tx,
  manifest: readonly DrawingImageManifestEntry[],
): Promise<MultimodalTaskInput['images']> {
  // This existing reader uses only select; Tx shares that API and keeps publish on its connection.
  const load = createAssessmentAssetLoader(db as Db, (key) => getR2().get(key));
  const signal = AbortSignal.timeout(30_000);
  const images: MultimodalTaskInput['images'] = [];
  const loaded = new Map<
    string,
    { image: MultimodalTaskInput['images'][number]; byteSize: number }
  >();
  let totalBytes = 0;
  if (manifest.length > 16) throw new DrawingImageInputError();
  for (const entry of manifest) {
    const identity = `${entry.asset_id}:${entry.digest}`;
    const cached = loaded.get(identity);
    if (cached) {
      totalBytes += cached.byteSize;
      if (totalBytes > MAX_IMAGE_BYTES) throw new DrawingImageInputError();
      images.push(cached.image);
      continue;
    }
    let asset: Awaited<ReturnType<typeof load>>;
    try {
      asset = await withinAssessmentSignal(() => load(entry, signal), signal);
    } catch {
      throw new DrawingImageInputError();
    }
    if (!asset) throw new DrawingImageInputError();
    totalBytes += asset.bytes.length;
    if (
      !IMAGE_MIMES.has(asset.mime_type) ||
      asset.bytes.length === 0 ||
      totalBytes > MAX_IMAGE_BYTES ||
      `sha256:${createHash('sha256').update(asset.bytes).digest('hex')}` !== entry.digest
    )
      throw new DrawingImageInputError();
    const image = { data: Buffer.from(asset.bytes).toString('base64'), mediaType: asset.mime_type };
    loaded.set(identity, { image, byteSize: asset.bytes.length });
    images.push(image);
  }
  return images;
}

export async function loadDrawingImageInput(
  db: Db,
  source: ImageSource & { brief: string; alt: string; caption: string | null },
): Promise<MultimodalTaskInput> {
  const image_manifest = await readDrawingImageManifest(db, source);
  const images = await loadDrawingImageBytes(db, image_manifest);
  return {
    text: JSON.stringify({
      brief: source.brief,
      alt: source.alt,
      ...(source.caption ? { caption: source.caption } : {}),
      image_manifest,
    }),
    images,
  };
}
