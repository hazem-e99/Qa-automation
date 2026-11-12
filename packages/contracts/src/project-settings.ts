import { z } from 'zod';

/**
 * Typed project settings sections (doc 10: JSONB validated by Zod with a schema version).
 * Only the sections the pilot needs exist; each has complete defaults, so a project without a
 * stored row still has a valid configuration.
 */
const Tag = z.string().trim().min(1).max(40);

export const TestingRulesSettings = z.object({
  requiredTags: z.array(Tag).max(20).default([]),
  defaultPriority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  /** Test case title pattern, e.g. "^[A-Z]" — validated as a regular expression. */
  titlePattern: z
    .string()
    .max(200)
    .refine((v) => {
      try {
        new RegExp(v);
        return true;
      } catch {
        return false;
      }
    }, 'not a valid regular expression')
    .default(''),
  mandatoryFields: z
    .array(z.enum(['preconditions', 'expectedResult', 'priority', 'tags']))
    .default(['expectedResult']),
});

export const ExecutionSettings = z.object({
  maxParallelRuns: z.number().int().min(1).max(8).default(2),
  maxShards: z.number().int().min(1).max(8).default(1),
  testTimeoutSeconds: z.number().int().min(5).max(3600).default(60),
  runTimeoutMinutes: z.number().int().min(1).max(360).default(60),
  retries: z.number().int().min(0).max(3).default(1),
  browsers: z
    .array(z.enum(['chromium', 'firefox', 'webkit']))
    .min(1)
    .default(['chromium']),
  artifactRetentionDays: z.number().int().min(1).max(365).default(30),
  /** Running pull-request branches from forks is denied by default (doc 17). */
  allowForkPullRequests: z.boolean().default(false),
  /** BR-M02-5: production environments are only usable for read-only smoke runs, with approval. */
  allowProductionSmoke: z.boolean().default(false),
});

export const AiSettings = z.object({
  enabled: z.boolean().default(false),
  monthlyBudgetUsd: z.number().min(0).max(10_000).default(0),
  /** The owner has agreed that redacted project content may be sent to the AI provider. */
  dataSharingConsent: z.boolean().default(false),
  disabledTasks: z.array(z.string().max(80)).max(50).default([]),
});

export const QualitySettings = z.object({
  requirementCoverageTargetPct: z.number().min(0).max(100).default(80),
  flakyThresholdPct: z.number().min(0).max(100).default(5),
});

export const SETTINGS_SECTIONS = {
  testing_rules: { schema: TestingRulesSettings, schemaVersion: 1 },
  execution: { schema: ExecutionSettings, schemaVersion: 1 },
  ai: { schema: AiSettings, schemaVersion: 1 },
  quality: { schema: QualitySettings, schemaVersion: 1 },
} as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
export const isSettingsSection = (v: unknown): v is SettingsSection =>
  typeof v === 'string' && Object.hasOwn(SETTINGS_SECTIONS, v);

export const SettingsResponse = z.object({
  section: z.string(),
  schemaVersion: z.number().int(),
  version: z.number().int().min(0),
  data: z.record(z.string(), z.unknown()),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const UpdateSettingsRequest = z.object({
  /** The version the client last read. A stale version is refused (optimistic concurrency). */
  expectedVersion: z.number().int().min(0),
  data: z.record(z.string(), z.unknown()),
});

export const EnvironmentRequest = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrls: z.array(z.string().max(500)).min(1).max(10),
  allowedHosts: z.array(z.string().max(253)).max(50).default([]),
  isProduction: z.boolean().default(false),
  /** Write-only: test login data (e.g. storage state). Never returned. */
  authSecret: z.string().min(1).max(65_536).nullish(),
  resetHookUrl: z.string().max(500).nullish(),
  tags: z.array(Tag).max(20).default([]),
});
export type EnvironmentRequest = z.infer<typeof EnvironmentRequest>;

export const EnvironmentResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  baseUrls: z.array(z.string()),
  allowedHosts: z.array(z.string()),
  isProduction: z.boolean(),
  hasAuthSecret: z.boolean(),
  authSecretUpdatedAt: z.iso.datetime().nullable(),
  resetHookUrl: z.string().nullable(),
  tags: z.array(z.string()),
});
export type EnvironmentResponse = z.infer<typeof EnvironmentResponse>;

export const BindingRequest = z.object({
  role: z.enum([
    'repository',
    'test_repository',
    'requirements',
    'issue_tracker',
    'ci',
    'ai',
    'orchestrator',
  ]),
  connectionId: z.uuid(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const BindingResponse = z.object({
  id: z.uuid(),
  role: z.string(),
  connectionId: z.uuid(),
  config: z.record(z.string(), z.unknown()),
  mode: z.enum(['active', 'legacy_sync']),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** Optional capabilities the connection lacks; the calling features use their fallbacks. */
  warnings: z.array(z.string()),
});
export type BindingResponse = z.infer<typeof BindingResponse>;
