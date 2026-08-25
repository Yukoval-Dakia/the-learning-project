import type { Violation } from './green-bridge-pins.mjs';

export type { Violation } from './green-bridge-pins.mjs';

export type ContextRecord = {
  schema_version: 1;
  mode: 'context';
  status: 'ok' | 'failed';
  build: {
    number: string | null;
    pipeline: string | null;
    branch: string | null;
    commit: string | null;
  };
  head: { commit: string | null; tree: string | null };
  base: { branch: string; sha: string | null };
  pr: {
    number: number;
    head_sha: string | null;
    base_branch: string;
    base_sha: string | null;
  } | null;
  github: { event_name: string | null; sha: string | null; before: string | null } | null;
  pins: Record<string, string | number | null> | null;
  metadata: { key: string; set: boolean; error?: string } | null;
  checks: {
    buildkite_context: boolean;
    commit_matches_head: boolean;
    head_tree_resolved: boolean;
    base_present: boolean;
    pr_head_present: boolean | null;
    github_sha_matches: boolean | null;
    pins_fresh: boolean | null;
  };
  violations: Violation[];
};

export type GitProbe = {
  headCommit(): string | null;
  headTree(): string | null;
  mergeBaseSha(ref: string): string | null;
};

export declare const METADATA_KEY: string;

export function validateContext(input: {
  env: Record<string, string | undefined>;
  git: GitProbe;
  pinsText?: string | null;
  pinsError?: Violation | null;
  now?: Date;
}): { record: ContextRecord; violations: Violation[] };

export function markMetadataFailure(record: ContextRecord, error: string): ContextRecord;
