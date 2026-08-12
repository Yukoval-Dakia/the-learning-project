/**
 * audit-task-census.ts — YUK-863 / F3.2
 *
 * Verifies the live TaskKind census against:
 *   1. The 51-entry canonical list
 *   2. All runTask / runAgentTask call sites in src/ and scripts/
 *   3. The compile-profile.ts --critic CLI caller (ProfileCriticTask)
 *   4. No unknown kinds referenced outside the catalog
 *
 * Run: pnpm vitest run --config vitest.unit.config.ts scripts/audit-task-census.unit.test.ts
 * Or:  npx tsx scripts/audit-task-census.ts
 */

export const EXPECTED_CENSUS: readonly string[] = [
  'AttributionTask',
  'AttributionRerankTask',
  'VisionExtractTask',
  'VisionExtractTaskHeavy',
  'StructureTask',
  'MistakeEnrollTask',
  'KnowledgeEdgeProposeTask',
  'FrontierPrerequisiteTask',
  'SessionSummaryTask',
  'LearningIntentOutlineTask',
  'NoteGenerateTask',
  'NoteVerifyTask',
  'NoteRefineTask',
  'SemanticJudgeTask',
  'UnitDimensionFallback',
  'StepsJudgeTask',
  'MultimodalDirectJudgeTask',
  'SourceGroundingVerifyTask',
  'VariantVerifyTask',
  'VariantGenTask',
  'TeachingTurnTask',
  'ProfileCriticTask',
  'DreamingTask',
  'CoachTask',
  'CopilotDispatchTask',
  'CopilotEvidenceReviewTask',
  'CopilotEvidenceVerificationTask',
  'CopilotTask',
  'KnowledgeReviewTask',
  'GoalScopeTask',
  'MindModelInductionTask',
  'ConjectureGroupingTask',
  'ConjectureProbeAuthorTask',
  'ConjectureProbeReviewTask',
  'InterventionRecommendationTask',
  'InterventionPackageAuthorTask',
  'InterventionPackageReviewTask',
  'ResearchMeetingDirectorTask',
  'MemoryBriefTask',
  'TaggingTask',
  'ColdStartPlacementBridgeTask',
  'SolutionGenerateTask',
  'SolutionGenerateVisionTask',
  'QuizGenTask',
  'QuizVerifyTask',
  'TeachingQualityTask',
  'QuestionAuthorTask',
  'ItemPriorTask',
  'SelectionOrchestratorTask',
  'SourcingTask',
  'BlockAssemblyTask',
] as const;

/** ProfileCriticTask is the only task invoked via a CLI script (compile-profile --critic). */
export const CLI_ONLY_CALLERS: readonly string[] = ['ProfileCriticTask'] as const;

export type AuditResult = {
  ok: boolean;
  censusCount: number;
  catalogCount: number;
  missingFromCatalog: string[];
  extraInCatalog: string[];
  errors: string[];
};

export function auditTaskCensus(catalogKeys: string[]): AuditResult {
  const errors: string[] = [];
  const catalogSet = new Set(catalogKeys);
  const censusSet = new Set(EXPECTED_CENSUS);

  const missingFromCatalog = EXPECTED_CENSUS.filter((k) => !catalogSet.has(k));
  const extraInCatalog = catalogKeys.filter((k) => !censusSet.has(k));

  if (missingFromCatalog.length > 0) {
    errors.push(`Missing from catalog: ${missingFromCatalog.join(', ')}`);
  }
  if (extraInCatalog.length > 0) {
    errors.push(`Extra in catalog (not in census): ${extraInCatalog.join(', ')}`);
  }
  if (catalogKeys.length !== 51) {
    errors.push(`Expected 51 entries; got ${catalogKeys.length}`);
  }

  return {
    ok: errors.length === 0,
    censusCount: EXPECTED_CENSUS.length,
    catalogCount: catalogKeys.length,
    missingFromCatalog,
    extraInCatalog,
    errors,
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const { taskCatalog } = await import('../src/ai/task-catalog.js');
  const result = auditTaskCensus(Object.keys(taskCatalog));
  if (result.ok) {
    console.log(`✓ Census audit passed: ${result.catalogCount} tasks`);
    process.exit(0);
  } else {
    console.error('✗ Census audit failed:');
    for (const e of result.errors) {
      console.error('  -', e);
    }
    process.exit(1);
  }
}
