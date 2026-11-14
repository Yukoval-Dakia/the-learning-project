import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type {
  DurableFamilyAdapter,
  DurableMemberRule,
  JobDecl,
  MountedDurableFamily,
} from '@/kernel/manifest';

/**
 * Generic durable-family admission and mounting. The registrar groups every
 * `backend:'dbos'` manifest job by its declared `durable.family`, resolves the
 * family's own adapter through `durable.load`, validates the group's members
 * against `adapter.members`, and mounts each admitted family through
 * `adapter.mount`. Member names, pairing, and the complete-set policy live on
 * the family adapter — this module never enumerates a family or member name.
 */

/** Boundaries the host binds per family for test/observability hooks. */
export type FamilyBoundaries = Readonly<Record<string, unknown>>;

export type AdmittedFamily = {
  family: string;
  adapter: DurableFamilyAdapter;
  /** This family's admitted member declarations, keyed by member name. */
  decls: Record<string, JobDecl>;
};

export type DurableAdmissionScope = 'production' | 'family';

/** Validate one member declaration against its family's admitted rule shape. */
export function checkMemberShape(decl: JobDecl, rule: DurableMemberRule): string | undefined {
  if (decl.name !== rule.name) return `expected name ${rule.name}`;
  if (decl.backend !== 'dbos') return 'backend must be dbos';
  if (decl.queue !== rule.queue) return `queue must be ${rule.queue}`;
  if (decl.load) return 'dbos families declare no job load';
  if (rule.scheduled && !decl.schedule) return 'must declare a schedule';
  if (!rule.scheduled && decl.schedule) return 'must not declare a schedule';
  if (decl.schedule) {
    if (!decl.schedule.cron.trim() || !decl.schedule.tz.trim())
      return 'schedule requires a non-empty cron and tz';
    if (
      rule.singleton === 'forbidden' &&
      (decl.schedule.singletonKey !== undefined || decl.schedule.singletonSeconds !== undefined)
    )
      return 'singleton throttling is not admitted for this member';
    if (
      rule.singleton === 'allowed' &&
      (decl.schedule.singletonKey === undefined) !== (decl.schedule.singletonSeconds === undefined)
    )
      return 'singletonKey and singletonSeconds must be declared together';
  }
  return undefined;
}

/**
 * Resolve each declared dbos family to its adapter and validate the member
 * set. Every `durable.load` for a family must resolve to the same adapter; a
 * member whose family loads no adapter, an unknown/malformed member, an
 * unpaired member, or a missing `required` member fails admission. Production
 * scope also enforces each adapter's required family peers. `mount` is not
 * called here — the host mounts after DBOS configuration.
 */
export async function admitDurableFamilies(
  decls: readonly JobDecl[],
  options: { scope?: DurableAdmissionScope } = {},
): Promise<AdmittedFamily[]> {
  const scope = options.scope ?? 'production';
  const durable = decls.filter((decl) => decl.backend === 'dbos');
  const adapters = new Map<string, DurableFamilyAdapter>();
  const groups = new Map<string, JobDecl[]>();
  const declarationOwners = new Map<string, string>();
  const ruleOwners = new Map<string, string>();
  const adapterLabels = new Map<string, string>();
  for (const decl of durable) {
    const family = decl.durable?.family;
    if (!family || !decl.durable?.load)
      throw new Error(`Invalid or duplicate admitted DBOS family ${decl.name}`);
    if (declarationOwners.has(decl.name))
      throw new Error(`Duplicate admitted DBOS declaration ${decl.name}`);
    declarationOwners.set(decl.name, family);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family)?.push(decl);
    const adapter = await decl.durable.load();
    const prior = adapters.get(family);
    if (prior && prior !== adapter)
      throw new Error(`Family ${family} resolved to multiple adapters`);
    adapters.set(family, adapter);
    const priorLabelOwner = adapterLabels.get(adapter.label);
    if (priorLabelOwner && priorLabelOwner !== family)
      throw new Error(`Durable family label ${adapter.label} is owned by multiple families`);
    adapterLabels.set(adapter.label, family);
  }
  const admitted: AdmittedFamily[] = [];
  for (const [family, members] of groups) {
    const adapter = adapters.get(family);
    if (!adapter) throw new Error(`Invalid or duplicate admitted DBOS family ${family}`);
    if (!adapter.label.trim() || !adapter.members.length)
      throw new Error(`Invalid durable family adapter ${family}`);
    const rules = new Map(adapter.members.map((rule) => [rule.name, rule]));
    if (rules.size !== adapter.members.length)
      throw new Error(`Invalid durable family adapter ${family}: duplicate member rule`);
    for (const rule of adapter.members) {
      const priorOwner = ruleOwners.get(rule.name);
      if (priorOwner && priorOwner !== family)
        throw new Error(`Durable member ${rule.name} is owned by multiple families`);
      ruleOwners.set(rule.name, family);
      if (rule.pairedWith !== undefined) {
        const partner = rules.get(rule.pairedWith);
        if (!partner || partner.pairedWith !== rule.name)
          throw new Error(`Invalid durable family adapter ${family}: unpaired member rule`);
      }
    }
    const declsByName: Record<string, JobDecl> = {};
    const seen = new Set<string>();
    for (const decl of members) {
      const rule = rules.get(decl.name);
      if (!rule || checkMemberShape(decl, rule) || seen.has(decl.name))
        throw new Error(`Invalid or duplicate admitted DBOS family ${decl.name}`);
      seen.add(decl.name);
      declsByName[decl.name] = decl;
    }
    for (const rule of adapter.members) {
      if (rule.required && !declsByName[rule.name])
        throw new Error(
          `Production DBOS admission requires the complete family set; missing ${rule.name}`,
        );
      if (rule.pairedWith !== undefined) {
        const partner = rules.get(rule.pairedWith);
        if (Boolean(declsByName[rule.name]) !== Boolean(partner && declsByName[partner.name]))
          throw new Error(
            `${adapter.label}: execution and reconciliation require paired ownership`,
          );
      }
    }
    admitted.push({ family, adapter, decls: declsByName });
  }
  if (scope === 'production') {
    const families = new Set(admitted.map(({ family }) => family));
    const byFamily = new Map(admitted.map((entry) => [entry.family, entry]));
    if (!admitted.some(({ adapter }) => adapter.requiredPeers.length))
      throw new Error('Production DBOS admission requires a durable family policy');
    for (const { family, adapter } of admitted) {
      if (new Set(adapter.requiredPeers).size !== adapter.requiredPeers.length)
        throw new Error(`Invalid durable family policy ${adapter.label}: duplicate peer`);
      for (const peer of adapter.requiredPeers) {
        if (peer === family) throw new Error(`Invalid durable family policy ${adapter.label}`);
        const requiredPeer = byFamily.get(peer);
        if (!families.has(peer) || !requiredPeer)
          throw new Error(
            `Production DBOS admission requires the complete family set; missing ${peer}`,
          );
        if (!requiredPeer.adapter.required)
          throw new Error(`Invalid durable family policy ${adapter.label}: optional peer ${peer}`);
      }
    }
  }
  return admitted;
}

/** Mount every admitted family through its adapter; returns lifecycle handles. */
export async function mountDurableFamilies(args: {
  boss: PgBoss;
  db: Db;
  families: readonly AdmittedFamily[];
  boundaries: FamilyBoundaries;
}): Promise<MountedDurableFamily[]> {
  const mounted: MountedDurableFamily[] = [];
  for (const { adapter, decls } of args.families) {
    const handle = await adapter.mount({
      boss: args.boss,
      db: args.db,
      decls,
      boundaries: args.boundaries,
    });
    if (handle) mounted.push(handle);
  }
  return mounted;
}
