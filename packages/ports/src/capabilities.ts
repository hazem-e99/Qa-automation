import type { CapabilityId, ProviderFamily } from './providers.js';

/** The capability catalog (doc 12 §2). Adapters may only declare capabilities listed here. */
export const CAPABILITY_CATALOG: Readonly<Record<ProviderFamily, readonly CapabilityId[]>> = {
  source_control: [
    'repo.read@1',
    'repo.commits.list@1',
    'repo.diff.read@1',
    'repo.branch.create@1',
    'repo.commit.push@1',
    'repo.pr.create@1',
    'repo.pr.read@1',
    'repo.pr.comment@1',
    'repo.branch.protection.read@1',
    'repo.checks.report@1',
    'repo.clone_token.issue@1',
    'repo.webhooks.manage@1',
  ],
  requirements: [
    'requirements.list_changed@1',
    'requirements.get@1',
    'requirements.revisions@1',
    'requirements.links@1',
    'requirements.attachments.read@1',
    'requirements.query.validate@1',
  ],
  issue_tracking: [
    'issues.metadata.read@1',
    'issues.create@1',
    'issues.get@1',
    'issues.update@1',
    'issues.list_changed@1',
    'issues.comment@1',
    'issues.attachments.create@1',
    'issues.transition@1',
    'issues.search_by_marker@1',
    'issues.links@1',
  ],
  ci: [
    'ci.pipeline.trigger@1',
    'ci.pipeline.status@1',
    'ci.artifacts.read@1',
    'ci.events.deployments@1',
    'ci.status.report@1',
  ],
  ai: [
    'ai.generate.structured@1',
    'ai.generate.text@1',
    'ai.embed@1',
    'ai.vision@1',
    'ai.tools@1',
    'ai.prompt_cache@1',
  ],
  storage: ['storage.put@1', 'storage.get@1', 'storage.delete@1', 'storage.signed_url@1', 'storage.list@1'],
  orchestration: [
    'orchestrator.dispatch@1',
    'orchestrator.health@1',
    'orchestrator.templates.deploy@1',
    'orchestrator.executions.read@1',
  ],
  test_engine: [
    'engine.discover@1',
    'engine.runspec@1',
    'engine.results.parse@1',
    'engine.trace@1',
    'engine.visual_compare@1',
    'engine.codegen@1',
  ],
  execution_backend: [
    'backend.provision@1',
    'backend.cancel@1',
    'backend.logs.stream@1',
    'backend.collect@1',
    'backend.reconcile@1',
  ],
  secrets: ['secrets.put@1', 'secrets.get@1', 'secrets.rotate@1', 'secrets.delete@1'],
  notifications: ['notify.send@1'],
  identity: ['identity.login@1', 'identity.oidc@1', 'identity.groups@1'],
};

export type BindingRole =
  'repository' | 'test_repository' | 'requirements' | 'issue_tracker' | 'ci' | 'ai' | 'orchestrator';

/**
 * Capabilities each binding role needs (doc 12 §3). `requiredAnyOf` lists groups where at least
 * one capability must be present (e.g. CI needs trigger or deployment events).
 */
export const ROLE_REQUIREMENTS: Readonly<
  Record<
    BindingRole,
    {
      readonly family: ProviderFamily;
      readonly required: readonly CapabilityId[];
      readonly requiredAnyOf?: readonly (readonly CapabilityId[])[];
      readonly optional: readonly CapabilityId[];
    }
  >
> = {
  repository: {
    family: 'source_control',
    required: ['repo.read@1', 'repo.commits.list@1'],
    optional: ['repo.diff.read@1', 'repo.webhooks.manage@1', 'repo.checks.report@1'],
  },
  test_repository: {
    family: 'source_control',
    required: ['repo.read@1', 'repo.clone_token.issue@1'],
    optional: [
      'repo.branch.create@1',
      'repo.commit.push@1',
      'repo.pr.create@1',
      'repo.branch.protection.read@1',
    ],
  },
  requirements: {
    family: 'requirements',
    required: ['requirements.list_changed@1', 'requirements.get@1'],
    optional: ['requirements.revisions@1', 'requirements.links@1', 'requirements.attachments.read@1'],
  },
  issue_tracker: {
    family: 'issue_tracking',
    required: [
      'issues.metadata.read@1',
      'issues.create@1',
      'issues.get@1',
      'issues.update@1',
      'issues.list_changed@1',
    ],
    optional: [
      'issues.search_by_marker@1',
      'issues.comment@1',
      'issues.attachments.create@1',
      'issues.transition@1',
      'issues.links@1',
    ],
  },
  ci: {
    family: 'ci',
    required: ['ci.pipeline.status@1'],
    requiredAnyOf: [['ci.pipeline.trigger@1', 'ci.events.deployments@1']],
    optional: ['ci.artifacts.read@1', 'ci.status.report@1'],
  },
  ai: {
    family: 'ai',
    required: ['ai.generate.structured@1'],
    optional: ['ai.embed@1', 'ai.vision@1', 'ai.tools@1', 'ai.prompt_cache@1'],
  },
  orchestrator: {
    family: 'orchestration',
    required: ['orchestrator.dispatch@1', 'orchestrator.health@1'],
    optional: ['orchestrator.templates.deploy@1', 'orchestrator.executions.read@1'],
  },
};

export interface CapabilityDiff {
  readonly ok: boolean;
  readonly familyMismatch: boolean;
  readonly missingRequired: readonly CapabilityId[];
  /** Groups where none of the alternatives is available. */
  readonly missingAnyOf: readonly (readonly CapabilityId[])[];
  readonly missingOptional: readonly CapabilityId[];
}

/** Compares a connection's effective capabilities with what a role needs (BR-M02-2, M02-AC-02). */
export function capabilityDiff(
  role: BindingRole,
  family: ProviderFamily,
  effective: readonly CapabilityId[],
): CapabilityDiff {
  const need = ROLE_REQUIREMENTS[role];
  const have = new Set(effective);
  const familyMismatch = need.family !== family;
  const missingRequired = need.required.filter((c) => !have.has(c));
  const missingAnyOf = (need.requiredAnyOf ?? []).filter((group) => !group.some((c) => have.has(c)));
  const missingOptional = need.optional.filter((c) => !have.has(c));
  return {
    ok: !familyMismatch && missingRequired.length === 0 && missingAnyOf.length === 0,
    familyMismatch,
    missingRequired,
    missingAnyOf,
    missingOptional,
  };
}

export const isCatalogCapability = (family: ProviderFamily, c: string): c is CapabilityId =>
  (CAPABILITY_CATALOG[family] as readonly string[]).includes(c);
