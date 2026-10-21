// Assemble the six subject tables into an in-memory SubjectRegistry.
//
// The db handle is injected (type-only) so kernel carries no runtime env.
// - Hydrate before serving; the worker also reconciles every 60s.
// - Never throws: missing tables (42P01), DB down, or bad rows warn and keep the
//   current registry; the four code seeds are the floor.
// - Load every subject including retired ones so old rows/events/domains never
//   dangle; selectable filtering belongs to the read surface.
// - Hydrate aliases in the same pass or legacy names miss.
// - Each trait degrades independently: keep last-good in memory, replay the
//   journal newest-first, then use the code seed for seed-lineage traits. A dead
//   custom trait drops that subject for this round.
// - Degraded versions name what is effective: id@revision or id@seed:version.
// - Custom ids absent from the DB row set are removed; builtin seeds never are.
// - Strict consumers must check each resolution's degraded flag, not just
//   `hydrated` or the version string.

import { desc, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  subject,
  subject_name_claim,
  subject_trait,
  subject_trait_binding,
  subject_trait_journal,
} from '@/db/schema';
import { BUILTIN_SUBJECT_IDS, BUILTIN_TRAIT_SEEDS } from '@/subjects/builtin-trait-seeds';
import {
  type SubjectRegistry,
  getDefaultSubjectRegistry,
  subjectProfiles,
} from '@/subjects/profile';
import {
  type TraitVersionComponent,
  assembleSubjectProfile,
  composeJudgeTraitVersion,
} from '@/subjects/trait-compose';
import {
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
  TRAIT_PAYLOAD_SCHEMAS,
  parseTraitPayloads,
} from '@/subjects/trait-schemas';
import { type TraitResolution, replaceSubjectTraitResolutions } from './subject-trait-resolutions';

// Hydration only reads; Tx shares the caller's connection and lock context.
// Isolation comes from the private registry instance, not a transaction snapshot.
export type DbOrTx = Db | Tx;

const BUILTIN_ID_SET: ReadonlySet<string> = new Set<string>(BUILTIN_SUBJECT_IDS);

export interface HydrationReport {
  hydrated: string[];
  builtinFloor: string[]; // builtin subjects whose custom trait died and fell back to code
  skipped: Array<{ subjectId: string; reason: string }>;
  removed: string[]; // custom ids removed by reconciliation
  // Per-trait provenance for assembled subjects. degraded !== null means the trait
  // is not live; that is the strict-consumer check.
  resolutions: Map<string, TraitResolution[]>;
}

function parseSeedSubjectFromTraitId(traitId: string): string | null {
  for (const sid of BUILTIN_SUBJECT_IDS) {
    for (const kind of SUBJECT_TRAIT_KINDS) {
      if (traitId === `trt_seed_${sid}_${kind}`) return sid;
    }
  }
  return null;
}

interface TraitRow {
  id: string;
  trait_kind: string;
  origin: 'builtin' | 'custom';
  payload: unknown;
  seed_version: string | null;
  owner_subject_id: string | null;
  revision: number;
}

// Single-trait degradation chain. null means a dead custom trait; the caller routes
// by binding origin. Journal rows are read newest-first.
async function resolveTraitPayload(
  db: DbOrTx,
  kind: SubjectTraitKind,
  row: TraitRow,
): Promise<{ payload: unknown; resolution: TraitResolution } | null> {
  const schema = TRAIT_PAYLOAD_SCHEMAS[kind];
  const base: Omit<TraitResolution, 'effective' | 'degraded'> = {
    kind,
    traitId: row.id,
    origin: row.origin,
    ownerSubjectId: row.owner_subject_id,
    seedVersion: row.seed_version,
    liveRevision: row.revision,
  };

  const live = schema.safeParse(row.payload);
  if (live.success) {
    return {
      payload: live.data,
      resolution: { ...base, effective: row.revision, degraded: null },
    };
  }
  console.warn('[subjects] trait live payload failed schema — entering degradation chain', {
    traitId: row.id,
    kind,
    issues: live.error.issues.slice(0, 3),
  });

  // Replay newest-first; the first payload that parses is the snapshot.
  const journalRows = await db
    .select({
      revision: subject_trait_journal.revision,
      payload: subject_trait_journal.payload,
    })
    .from(subject_trait_journal)
    .where(eq(subject_trait_journal.trait_id, row.id))
    .orderBy(desc(subject_trait_journal.revision));
  for (const j of journalRows) {
    const parsed = schema.safeParse(j.payload);
    if (parsed.success) {
      return {
        payload: parsed.data,
        resolution: { ...base, effective: j.revision, degraded: 'journal_fallback' },
      };
    }
  }

  // Code seed, only for seed-lineage traits, with synthetic identity seed:<version>.
  if (row.seed_version !== null) {
    const seedSubject = parseSeedSubjectFromTraitId(row.id);
    if (seedSubject) {
      const seed = BUILTIN_TRAIT_SEEDS[seedSubject as (typeof BUILTIN_SUBJECT_IDS)[number]][kind];
      console.warn('[subjects] trait degraded to code seed', { traitId: row.id, kind });
      return {
        payload: seed.payload,
        resolution: {
          ...base,
          effective: `seed:${seed.seedVersion}`,
          degraded: 'code_seed',
        },
      };
    }
  }
  return null; // Dead custom/fork trait; the caller routes by binding origin.
}

export async function hydrateSubjectRegistryFromDb(
  db: DbOrTx,
  registry: SubjectRegistry = getDefaultSubjectRegistry(),
): Promise<HydrationReport> {
  const report: HydrationReport = {
    hydrated: [],
    builtinFloor: [],
    skipped: [],
    removed: [],
    resolutions: new Map(),
  };
  try {
    const [subjectRows, bindingRows, traitRows, aliasRows] = await Promise.all([
      db.select().from(subject),
      db.select().from(subject_trait_binding),
      db.select().from(subject_trait),
      db.select().from(subject_name_claim).where(eq(subject_name_claim.kind, 'alias')),
    ]);

    const traitById = new Map(traitRows.map((t) => [t.id, t as TraitRow]));
    const bindingsBySubject = new Map<string, Map<SubjectTraitKind, string>>();
    for (const b of bindingRows) {
      const m = bindingsBySubject.get(b.subject_id) ?? new Map<SubjectTraitKind, string>();
      m.set(b.trait_kind as SubjectTraitKind, b.trait_id);
      bindingsBySubject.set(b.subject_id, m);
    }
    const aliasesBySubject = new Map<string, string[]>();
    for (const a of aliasRows) {
      aliasesBySubject.set(a.subject_id, [
        ...(aliasesBySubject.get(a.subject_id) ?? []),
        a.name_norm,
      ]);
    }

    const nextResolutions = new Map<string, TraitResolution[]>();
    const seenIds = new Set<string>();

    for (const row of subjectRows) {
      seenIds.add(row.id);
      const bindings = bindingsBySubject.get(row.id);
      const resolutions: TraitResolution[] = [];
      const payloads: Partial<Record<SubjectTraitKind, unknown>> = {};
      let dead: string | null = null;

      for (const kind of SUBJECT_TRAIT_KINDS) {
        const traitId = bindings?.get(kind);
        const traitRow = traitId ? traitById.get(traitId) : undefined;
        if (!traitRow) {
          dead = `binding/trait missing for kind '${kind}'`;
          break;
        }
        const resolved = await resolveTraitPayload(db, kind, traitRow);
        if (!resolved) {
          dead = `trait '${traitRow.id}' (${kind}) unrecoverable`;
          break;
        }
        payloads[kind] = resolved.payload;
        resolutions.push(resolved.resolution);
      }

      if (dead) {
        if (BUILTIN_ID_SET.has(row.id)) {
          // Builtin floor: even with a dead custom trait, return the import-time code
          // profile explicitly rather than last-good. The floor is deterministic.
          const floor = subjectProfiles[row.id];
          if (floor) {
            registry.upsert(floor, [], {
              throwOnInvalid: false,
              // Floor metadata also returns deterministically to builtin defaults.
              meta: {
                isBuiltin: true,
                isSelectable: row.id !== 'general' && row.is_selectable,
                retiredAt: row.retired_at,
              },
            });
          }
          console.warn('[subjects] builtin subject fell back to import-time code profile', {
            subjectId: row.id,
            reason: dead,
          });
          report.builtinFloor.push(row.id);
        } else {
          // Custom subject is absent this round, not removed: last-good stays in memory.
          console.warn('[subjects] custom subject skipped this hydration round', {
            subjectId: row.id,
            reason: dead,
          });
          report.skipped.push({ subjectId: row.id, reason: dead });
        }
        continue;
      }

      const byKind = new Map(resolutions.map((r) => [r.kind, r]));
      const comp = (k: SubjectTraitKind): TraitVersionComponent => {
        // All six kinds resolved, so the lookup exists.
        const r = byKind.get(k)!;
        return { traitId: r.traitId, effective: r.effective };
      };
      const profile = assembleSubjectProfile({
        id: row.id,
        displayName: row.display_name,
        version: composeJudgeTraitVersion({
          charter: comp('charter'),
          judge_policy: comp('judge_policy'),
          cause_taxonomy: comp('cause_taxonomy'),
          source_policy: comp('source_policy'),
        }),
        payloads: parseTraitPayloads(payloads),
      });

      const result = registry.upsert(profile, aliasesBySubject.get(row.id) ?? [], {
        throwOnInvalid: false, // Bad assembly skips with a warn instead of killing the process.
        // DB row is authoritative for the three metadata flags.
        meta: {
          isBuiltin: row.origin === 'builtin',
          isSelectable: row.is_selectable,
          retiredAt: row.retired_at,
        },
      });
      if (result.valid) {
        report.hydrated.push(row.id);
        nextResolutions.set(row.id, resolutions);
      } else {
        console.warn('[subjects] assembled profile failed validateProfile — keeping last-good', {
          subjectId: row.id,
          errors: result.errors.slice(0, 3),
        });
        report.skipped.push({ subjectId: row.id, reason: 'validateProfile failed' });
      }
    }

    // Remove in-memory custom ids absent from this DB row set; builtins never.
    for (const id of registry.listIds()) {
      if (BUILTIN_ID_SET.has(id)) continue;
      if (!seenIds.has(id)) {
        registry.remove(id);
        report.removed.push(id);
        console.warn(
          '[subjects] removed stale custom subject from registry (restore shrank rows?)',
          {
            subjectId: id,
          },
        );
      }
    }

    // Only the global default registry feeds the shared resolution cache; a private
    // hydration snapshot must not leak into it.
    if (registry === getDefaultSubjectRegistry()) {
      replaceSubjectTraitResolutions(nextResolutions); // Replace the reference, not the old object.
    }
    report.resolutions = nextResolutions;
    return report;
  } catch (err) {
    // Missing tables, DB down, or anything else: warn and keep the code-seed floor.
    console.warn('[subjects] hydration failed — registry keeps code-seed floor / last-good', err);
    return report;
  }
}
