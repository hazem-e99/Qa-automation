import type { Principal } from '@qos/identity';
import {
  createConnection,
  listConnections,
  testConnection,
  type ConnectionView,
  type IntegrationDeps,
} from '@qos/integrations';
import {
  bindConnection,
  createEnvironment,
  createProject,
  findProjectByKey,
  listBindings,
  listEnvironments,
  type Project,
} from '@qos/projects';
import type { BindingRole } from '@qos/ports';

/**
 * Demo seed (T-P2-04, doc 23 §6), the part that exists in P2: the two demo projects, mock
 * connections tested and bound to every role they can serve, and a staging environment.
 * Requirements, test cases, runs and defects join the seed in the phases that build them.
 *
 * Idempotent: running it again creates only what is missing, so the UI can offer it safely.
 * It runs only when demo mode is on, because only then are the mock providers registered.
 */
export const DEMO_PROJECTS = [
  { key: 'SHOP', name: 'ShopDemo', description: 'Sample web shop used to show QualityOS end to end.' },
  { key: 'API', name: 'ApiDemo', description: 'Second demo project, for multi-project isolation demos.' },
] as const;

const DEMO_CONNECTIONS = [
  { providerType: 'mock_repository', displayName: 'Demo repository', roles: ['repository'] },
  { providerType: 'mock_issue_tracker', displayName: 'Demo tracker', roles: ['issue_tracker'] },
] as const satisfies readonly { providerType: string; displayName: string; roles: readonly BindingRole[] }[];

/** Mock credentials grant every capability unless `scopes=` limits them; not a real secret. */
const DEMO_CREDENTIAL = 'mock-demo-credential-full';

export interface DemoSeedResult {
  readonly created: { projects: string[]; connections: string[]; bindings: string[]; environments: string[] };
  readonly projects: string[];
}

export async function seedDemo(deps: IntegrationDeps, actor: Principal): Promise<DemoSeedResult> {
  const created: DemoSeedResult['created'] = {
    projects: [],
    connections: [],
    bindings: [],
    environments: [],
  };
  const orgActor = { orgId: actor.orgId, userId: actor.userId };

  const connections = new Map<string, ConnectionView>();
  const existing = await listConnections(deps.db, orgActor);
  for (const c of DEMO_CONNECTIONS) {
    let conn = existing.find((e) => e.displayName === c.displayName && e.status !== 'retired');
    if (!conn) {
      conn = await createConnection(deps, orgActor, {
        providerType: c.providerType,
        displayName: c.displayName,
        authStrategy: 'pat',
        credential: DEMO_CREDENTIAL,
      });
      created.connections.push(c.displayName);
    }
    // A binding needs capabilities confirmed by a test; testing again is harmless.
    if (conn.status !== 'active') conn = (await testConnection(deps, orgActor, conn.id)).connection;
    connections.set(c.providerType, conn);
  }

  for (const p of DEMO_PROJECTS) {
    let project: Project | null = await findProjectByKey(deps.db, actor.orgId, p.key);
    if (project && !project.isDemo) continue; // a real project already uses this key: leave it alone
    if (!project) {
      project = await createProject(deps.db, actor, {
        key: p.key,
        name: p.name,
        description: p.description,
        isDemo: true,
      });
      created.projects.push(p.key);
    }
    if (project.status !== 'active' && project.status !== 'draft') continue;
    const bound = await listBindings(deps.db, project);
    for (const c of DEMO_CONNECTIONS) {
      const conn = connections.get(c.providerType)!;
      for (const role of c.roles) {
        if (bound.some((b) => b.role === role)) continue;
        await bindConnection(deps.db, actor, project, { role, connectionId: conn.id });
        created.bindings.push(`${p.key}:${role}`);
      }
    }
    if (p.key === 'SHOP' && !(await listEnvironments(deps.db, project)).length) {
      // The demo app runs as a Compose service (doc 23 §6); its host is the only allowed target.
      await createEnvironment(deps, actor, project, {
        name: 'staging',
        baseUrls: ['http://demo-app:8080'],
        allowedHosts: ['demo-app'],
        tags: ['demo'],
      });
      created.environments.push('SHOP:staging');
    }
  }
  return { created, projects: DEMO_PROJECTS.map((p) => p.key) };
}
