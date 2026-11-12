/**
 * Provider framework types (doc 11, doc 12 §1). Core modules depend on these shapes only;
 * concrete adapters live in `packages/adapters-*` and are wired by composition roots.
 */
export type ProviderFamily =
  | 'source_control'
  | 'requirements'
  | 'issue_tracking'
  | 'ci'
  | 'ai'
  | 'storage'
  | 'orchestration'
  | 'test_engine'
  | 'execution_backend'
  | 'secrets'
  | 'notifications'
  | 'identity';

/** `family.object.verb@major`, e.g. `issues.create@1`. */
export type CapabilityId = `${string}@${number}`;

export type AuthStrategy = 'pat' | 'github_app' | 'entra_client_credentials' | 'api_key' | 'basic' | 'none';

export interface CapabilityManifest {
  readonly providerType: string;
  readonly family: ProviderFamily;
  readonly adapterVersion: string;
  /** Shown in the catalog; never used for logic. */
  readonly displayName: string;
  readonly capabilities: readonly CapabilityId[];
  readonly limits: {
    readonly maxAttachmentBytes?: number;
    readonly maxPageSize?: number;
    readonly rateLimitHint?: string;
    readonly richText?: 'markdown' | 'html' | 'plain';
  };
  readonly authStrategies: readonly AuthStrategy[];
  readonly webhook?: {
    readonly verification: 'hmac_sha256' | 'shared_token' | 'basic_auth' | 'none';
    readonly deliveryIdHeader?: string;
  };
  /** Demo/mock adapters: their connections can only be bound to demo projects (doc 11 §8). */
  readonly demoOnly?: boolean;
}

export interface ConnectionTestResult {
  /** Who the credential authenticates as, e.g. a user or app name. Never a secret. */
  readonly identity: string;
  readonly scopesDiscovered: readonly string[];
  readonly permissionChecks: readonly { capability: CapabilityId; ok: boolean; missing?: string }[];
  readonly expiresAt?: string;
}

export interface ExternalRefData {
  readonly externalType: string;
  readonly externalId: string;
  readonly externalUrl?: string;
  readonly externalVersion?: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export type ProviderErrorKind =
  | 'auth_failed'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'validation'
  | 'unavailable'
  | 'timeout'
  | 'unknown';

/** Normalized provider failure (doc 11 §7). The message is sanitized: no secrets, no raw payloads. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly details: { retryAfterMs?: number; providerCode?: string; field?: string } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** A capability the adapter does not declare, or the connection does not have, was requested. */
export class CapabilityMissingError extends Error {
  constructor(readonly missing: readonly CapabilityId[]) {
    super(`missing capabilities: ${missing.join(', ')}`);
    this.name = 'CapabilityMissingError';
  }
}

/** Outbound HTTP as adapters see it. The composition root passes an SSRF-guarded client. */
export interface OutboundHttp {
  request(
    url: string,
    req?: { method?: string; headers?: Readonly<Record<string, string>>; body?: string | Uint8Array },
  ): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array; url: string }>;
}

export interface AdapterLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Everything an adapter may use (doc 11 §4). Nothing else: no database, no other connections. */
export interface ConnectionContext {
  readonly connectionId: string;
  readonly baseUrl: string | null;
  readonly http: OutboundHttp;
  /** Reads this connection's credential. Scoped: it cannot read any other secret. */
  readonly secret: () => Promise<string>;
  readonly log: AdapterLogger;
  readonly now: () => Date;
}

export interface ProviderAdapter {
  manifest(): CapabilityManifest;
  testConnection(ctx: ConnectionContext): Promise<ConnectionTestResult>;
}

// ---- source control (doc 12 §4.1, the subset used up to P2) ----
export interface RepoSummary {
  readonly id: string;
  readonly path: string;
}
export interface RepoInfo extends RepoSummary {
  readonly defaultBranch: string;
  readonly url: string;
  readonly visibility: 'public' | 'private' | 'internal';
}
export interface CanonicalCommit {
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly timestamp: string;
  readonly changedPaths?: readonly string[];
}
export interface CloneCredential {
  readonly url: string;
  readonly username?: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly readOnly: true;
}

export interface RepositoryProvider extends ProviderAdapter {
  listResources(ctx: ConnectionContext, q: { search?: string; cursor?: string }): Promise<Page<RepoSummary>>;
  getRepo(ctx: ConnectionContext, repoId: string): Promise<RepoInfo>;
  readFile(ctx: ConnectionContext, repoId: string, path: string, ref: string): Promise<Uint8Array | null>;
  listCommits(
    ctx: ConnectionContext,
    repoId: string,
    branch: string,
    cursor?: string,
  ): Promise<Page<CanonicalCommit>>;
  createBranch?(
    ctx: ConnectionContext,
    repoId: string,
    name: string,
    fromRef: string,
  ): Promise<ExternalRefData>;
  issueCloneCredential(ctx: ConnectionContext, repoId: string, ttlSeconds: number): Promise<CloneCredential>;
}

/** Branches QualityOS may create or push to (doc 12 §4.1). */
export const QOS_BRANCH_PREFIX = 'qos/';
