import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CreateConnectionRequest,
  RotateCredentialRequest,
  Uuid,
  type ConnectionResponse,
  type ProviderResponse,
} from '@qos/contracts';
import {
  checkConnectionForRole,
  connectionImpact,
  createConnection,
  getConnection,
  listCapabilities,
  listChecks,
  listConnections,
  retireConnection,
  rotateCredential,
  testConnection,
  createWebhookEndpoint,
  getWebhookEndpoint,
  type IntegrationDeps,
} from '@qos/integrations';
import { DomainError } from '@qos/kernel-domain';
import { bindingsUsingConnection } from '@qos/projects';
import { ROLE_REQUIREMENTS, type BindingRole } from '@qos/ports';
import { Auth, Authenticated, RequirePermission, type AuthContext } from './access.js';
import { INTEGRATIONS } from './tokens.js';

const actorOf = (auth: AuthContext) => ({ orgId: auth.principal.orgId, userId: auth.principal.userId });

@Controller('api/v1')
export class ConnectionsController {
  constructor(@Inject(INTEGRATIONS) private readonly deps: IntegrationDeps) {}

  /** Provider catalog with manifests (what this installation can connect to). */
  @Get('providers')
  @Authenticated()
  providers(): ProviderResponse[] {
    return this.deps.registry.catalog().map((m) => ({
      providerType: m.providerType,
      family: m.family,
      displayName: m.displayName,
      adapterVersion: m.adapterVersion,
      capabilities: [...m.capabilities],
      authStrategies: [...m.authStrategies],
      demoOnly: m.demoOnly === true,
    }));
  }

  @Get('connections')
  @RequirePermission('connection.manage')
  list(@Auth() auth: AuthContext): Promise<ConnectionResponse[]> {
    return listConnections(this.deps.db, actorOf(auth));
  }

  @Post('connections')
  @RequirePermission('connection.manage')
  @HttpCode(201)
  create(@Body() body: unknown, @Auth() auth: AuthContext): Promise<ConnectionResponse> {
    return createConnection(this.deps, actorOf(auth), CreateConnectionRequest.parse(body));
  }

  @Get('connections/:id')
  @RequirePermission('connection.manage')
  get(@Param('id') id: string, @Auth() auth: AuthContext): Promise<ConnectionResponse> {
    return getConnection(this.deps.db, actorOf(auth), Uuid.parse(id));
  }

  @Post('connections/:id/test')
  @RequirePermission('connection.manage')
  @HttpCode(200)
  test(@Param('id') id: string, @Auth() auth: AuthContext) {
    return testConnection(this.deps, actorOf(auth), Uuid.parse(id));
  }

  @Get('connections/:id/capabilities')
  @RequirePermission('connection.manage')
  capabilities(@Param('id') id: string, @Auth() auth: AuthContext) {
    return listCapabilities(this.deps.db, actorOf(auth), Uuid.parse(id));
  }

  @Get('connections/:id/checks')
  @RequirePermission('connection.manage')
  checks(@Param('id') id: string, @Auth() auth: AuthContext) {
    return listChecks(this.deps.db, actorOf(auth), Uuid.parse(id));
  }

  /** Can this connection serve a binding role? Returns the capability diff (M02-AC-02 groundwork). */
  @Get('connections/:id/role-check')
  @RequirePermission('connection.manage')
  roleCheck(@Param('id') id: string, @Query('role') role: string | undefined, @Auth() auth: AuthContext) {
    if (!role || !(role in ROLE_REQUIREMENTS)) throw new DomainError('connection.role_invalid');
    return checkConnectionForRole(this.deps.db, actorOf(auth), Uuid.parse(id), role as BindingRole);
  }

  @Post('connections/:id/rotate-secret')
  @RequirePermission('connection.secret.rotate')
  @HttpCode(200)
  rotate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
  ): Promise<ConnectionResponse> {
    const { credential } = RotateCredentialRequest.parse(body);
    return rotateCredential(this.deps, actorOf(auth), Uuid.parse(id), credential);
  }

  /** Webhook endpoint of a connection, without its secrets (they are shown only once). */
  @Get('connections/:id/webhook')
  @RequirePermission('connection.manage')
  async webhook(@Param('id') id: string, @Auth() auth: AuthContext) {
    const endpoint = await getWebhookEndpoint(this.deps.db, actorOf(auth), Uuid.parse(id));
    if (!endpoint) throw new DomainError('webhook.not_found');
    return endpoint;
  }

  /** Creates or rotates the endpoint. The answer holds the path and signing secret, once. */
  @Post('connections/:id/webhook')
  @RequirePermission('connection.secret.rotate')
  @HttpCode(201)
  createWebhook(
    @Param('id') id: string,
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    return createWebhookEndpoint(this.deps, actorOf(auth), Uuid.parse(id));
  }

  @Get('connections/:id/impact')
  @RequirePermission('connection.retire')
  async impact(@Param('id') id: string, @Auth() auth: AuthContext) {
    const connectionId = Uuid.parse(id);
    const refs = await connectionImpact(this.deps.db, actorOf(auth), connectionId);
    // Projects that would lose this binding: shown before retiring (T-P2-33).
    return {
      ...refs,
      bindings: await bindingsUsingConnection(this.deps.db, auth.principal.orgId, connectionId),
    };
  }

  @Post('connections/:id/retire')
  @RequirePermission('connection.retire')
  @HttpCode(200)
  retire(@Param('id') id: string, @Auth() auth: AuthContext): Promise<ConnectionResponse> {
    return retireConnection(this.deps, actorOf(auth), Uuid.parse(id));
  }
}
