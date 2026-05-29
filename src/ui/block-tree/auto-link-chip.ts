// YUK-95 P5 Lane-D (Wave 7) — relation-chip label + tone mapping for the
// AutoLinksContainer auto-zone (ADR-0020 §9 "chip 视觉").
//
// A crossLinkBlock child of an AutoLinksContainer is "system-maintained" when
// the nightly hub_auto_sync worker wrote it (Lane-C): it carries flat
// provenance attrs `auto: true` and `relation: <HubMeshRelation>`. User-inserted
// cross_links (Lane-A picker) have no `auto` flag and render with no chip.
//
// This module is PURE (no React, no DB, no IO) so the label mapping is unit
// tested in the unit partition (src/ui/** ∈ fastTestInclude). Both the read
// renderer (BlockTreeRenderer) and the editor NodeView (tiptap-extensions)
// consume it so the chip looks identical in read + edit.

// The four relation rules the hub-mesh curation surfaces (mirrors
// `HubMeshRelation` in src/server/knowledge/hub-mesh.ts — duplicated as a plain
// string union here to keep the UI layer free of any server import).
export type AutoLinkRelation = 'subtopic' | 'prerequisite' | 'derived_from' | 'contrasts_with';

// Per ADR-0020 §9: "via prerequisite" / "via 派生" / "via 对比" / "via 子主题".
const RELATION_CHIP_LABEL: Record<AutoLinkRelation, string> = {
  subtopic: 'via 子主题',
  prerequisite: 'via prerequisite',
  derived_from: 'via 派生',
  contrasts_with: 'via 对比',
};

// "系统维护" marker shown alongside the relation chip for auto-links.
export const AUTO_LINK_SYSTEM_LABEL = '系统维护';

// CSS modifier class per relation (tokens applied in globals.css). NOTE: the
// `--contrasts` purple token is being added in a parallel T-KG branch (not yet
// on main). Until T-KG merges, the `contrasts_with` chip reuses the neutral
// `--ink-4` tone (see .auto-link-chip--contrasts in globals.css). Phase-deferred:
// switch that rule to `--contrasts` once T-KG lands — do NOT add the token here
// (avoids a merge collision with T-KG). Tracked: YUK-95 follow-up.
const RELATION_CHIP_TONE_CLASS: Record<AutoLinkRelation, string> = {
  subtopic: 'auto-link-chip--subtopic',
  prerequisite: 'auto-link-chip--prerequisite',
  derived_from: 'auto-link-chip--derived',
  contrasts_with: 'auto-link-chip--contrasts',
};

export interface AutoLinkChip {
  /** Whether this cross-link is system-maintained (worker-written). */
  isAuto: boolean;
  /** Relation chip text, or null when not an auto-link / unknown relation. */
  relationLabel: string | null;
  /** Relation tone class, or null when not an auto-link / unknown relation. */
  relationToneClass: string | null;
}

function isAutoLinkRelation(value: unknown): value is AutoLinkRelation {
  return (
    value === 'subtopic' ||
    value === 'prerequisite' ||
    value === 'derived_from' ||
    value === 'contrasts_with'
  );
}

/**
 * Map a crossLinkBlock's flat attrs to its chip presentation. Tolerant of
 * arbitrary attr shapes (TipTap passes attrs through untyped):
 *   - `auto !== true` → not a system link (no chip, no system marker).
 *   - `auto === true` but `relation` missing/unknown → system marker only,
 *     no relation chip (defensive; the worker always writes a known relation).
 */
export function autoLinkChip(attrs: Record<string, unknown> | null | undefined): AutoLinkChip {
  const isAuto = (attrs?.auto ?? false) === true;
  if (!isAuto) {
    return { isAuto: false, relationLabel: null, relationToneClass: null };
  }
  const relation = attrs?.relation;
  if (!isAutoLinkRelation(relation)) {
    return { isAuto: true, relationLabel: null, relationToneClass: null };
  }
  return {
    isAuto: true,
    relationLabel: RELATION_CHIP_LABEL[relation],
    relationToneClass: RELATION_CHIP_TONE_CLASS[relation],
  };
}
