import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import {
  CreateApiTokenRequest,
  CreateInvitationRequest,
  CreateServiceAccountRequest,
  UpdateServiceAccountRequest,
  UpdateUserRequest,
  Uuid,
  type ApiTokenCreatedResponse,
  type ApiTokenResponse,
  type InvitationCreatedResponse,
  type InvitationResponse,
  type LinkResponse,
  type ServiceAccountResponse,
  type UserResponse,
} from '@qos/contracts';
import type { Tx } from '@qos/db';
import {
  createApiToken,
  createInvitation,
  createPasswordReset,
  createServiceAccount,
  deactivateUser,
  getUser,
  listApiTokens,
  listInvitations,
  listServiceAccounts,
  listUsers,
  reactivateUser,
  resendInvitation,
  resetUserMfa,
  revokeApiToken,
  revokeInvitation,
  updateServiceAccount,
  updateUser,
  type ApiTokenView,
  type InvitationView,
  type ServiceAccountView,
} from '@qos/identity';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import type { SecretStore } from '@qos/ports';
import { findProjectByKey } from '@qos/projects';
import type { FastifyReply } from 'fastify';
import { Auth, RequirePermission, type AuthContext } from './access.js';
import { userView } from './auth.controller.js';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA, SECRETS } from './tokens.js';

const invitationView = (i: InvitationView): InvitationResponse => ({
  ...i,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});
const accountView = (s: ServiceAccountView): ServiceAccountResponse => ({
  ...s,
  owner: { ...s.owner },
  createdAt: s.createdAt.toISOString(),
});
const tokenView = (t: ApiTokenView): ApiTokenResponse => ({
  ...t,
  scopes: [...t.scopes],
  projectIds: t.projectIds ? [...t.projectIds] : null,
  expiresAt: t.expiresAt.toISOString(),
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  revokedAt: t.revokedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

/**
 * Organization administration (M13 §7): users, invitations, service accounts and API tokens.
 * Every route needs `user.manage` (org_admin).
 */
@Controller('api/v1')
export class UsersController {
  constructor(
    @Inject(INFRA) private readonly infra: CoreInfra,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(SECRETS) private readonly secrets: SecretStore<Tx> | null,
  ) {}

  /** Links carry the token in the fragment, which browsers never send to a server or log. */
  private link(path: string, token: string, expiresAt: Date): LinkResponse {
    const base = this.config.PUBLIC_WEB_URL.replace(/\/+$/, '');
    return { url: `${base}/${path}#${token}`, expiresAt: expiresAt.toISOString() };
  }

  @Get('users')
  @RequirePermission('user.manage')
  async list(@Auth() auth: AuthContext): Promise<UserResponse[]> {
    return (await listUsers(this.infra.db, auth.principal.orgId)).map(userView);
  }

  @Get('users/:id')
  @RequirePermission('user.manage')
  async get(@Param('id') id: string, @Auth() auth: AuthContext): Promise<UserResponse> {
    return userView(await getUser(this.infra.db, auth.principal.orgId, Uuid.parse(id)));
  }

  @Patch('users/:id')
  @RequirePermission('user.manage')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
  ): Promise<UserResponse> {
    return userView(
      await updateUser(this.infra.db, auth.principal, Uuid.parse(id), UpdateUserRequest.parse(body)),
    );
  }

  @Post('users/:id/deactivate')
  @RequirePermission('user.manage')
  @HttpCode(200)
  async deactivate(@Param('id') id: string, @Auth() auth: AuthContext): Promise<UserResponse> {
    return userView(await deactivateUser(this.infra.db, auth.principal, Uuid.parse(id)));
  }

  @Post('users/:id/reactivate')
  @RequirePermission('user.manage')
  @HttpCode(200)
  async reactivate(@Param('id') id: string, @Auth() auth: AuthContext): Promise<UserResponse> {
    return userView(await reactivateUser(this.infra.db, auth.principal, Uuid.parse(id)));
  }

  /** Admin-generated reset link, shown once (no email in the pilot). */
  @Post('users/:id/password-reset')
  @RequirePermission('user.manage')
  @HttpCode(200)
  async passwordReset(
    @Param('id') id: string,
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LinkResponse> {
    reply.header('cache-control', 'no-store');
    const { token, expiresAt } = await createPasswordReset(this.infra.db, auth.principal, Uuid.parse(id));
    return this.link('reset-password', token, expiresAt);
  }

  /** Removes MFA from a user who lost their device. */
  @Post('users/:id/mfa/reset')
  @RequirePermission('user.manage')
  @HttpCode(204)
  async resetMfa(@Param('id') id: string, @Auth() auth: AuthContext): Promise<void> {
    await resetUserMfa(this.infra.db, this.secrets, auth.principal, Uuid.parse(id));
  }

  @Get('invitations')
  @RequirePermission('user.manage')
  async invitations(@Auth() auth: AuthContext): Promise<InvitationResponse[]> {
    return (await listInvitations(this.infra.db, auth.principal.orgId)).map(invitationView);
  }

  @Post('invitations')
  @RequirePermission('user.manage')
  @HttpCode(201)
  async invite(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InvitationCreatedResponse> {
    const input = CreateInvitationRequest.parse(body);
    let projectId: string | null = null;
    if (input.projectKey) {
      const project = await findProjectByKey(this.infra.db, auth.principal.orgId, input.projectKey);
      if (!project || project.status === 'deleted') throw new DomainError('invitation.project_not_found');
      projectId = project.id;
    }
    reply.header('cache-control', 'no-store');
    const { invitation, token } = await createInvitation(this.infra.db, auth.principal, {
      email: input.email,
      displayName: input.displayName,
      orgRole: input.orgRole ?? null,
      projectId,
      projectRole: input.projectRole ?? null,
    });
    return { invitation: invitationView(invitation), link: this.link('invite', token, invitation.expiresAt) };
  }

  @Post('invitations/:id/resend')
  @RequirePermission('user.manage')
  @HttpCode(200)
  async resend(
    @Param('id') id: string,
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InvitationCreatedResponse> {
    reply.header('cache-control', 'no-store');
    const { invitation, token } = await resendInvitation(this.infra.db, auth.principal, Uuid.parse(id));
    return { invitation: invitationView(invitation), link: this.link('invite', token, invitation.expiresAt) };
  }

  @Delete('invitations/:id')
  @RequirePermission('user.manage')
  @HttpCode(204)
  async revoke(@Param('id') id: string, @Auth() auth: AuthContext): Promise<void> {
    await revokeInvitation(this.infra.db, auth.principal, Uuid.parse(id));
  }

  @Get('service-accounts')
  @RequirePermission('user.manage')
  async serviceAccounts(@Auth() auth: AuthContext): Promise<ServiceAccountResponse[]> {
    return (await listServiceAccounts(this.infra.db, auth.principal.orgId)).map(accountView);
  }

  @Post('service-accounts')
  @RequirePermission('user.manage')
  @HttpCode(201)
  async createServiceAccount(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
  ): Promise<ServiceAccountResponse> {
    return accountView(
      await createServiceAccount(this.infra.db, auth.principal, CreateServiceAccountRequest.parse(body)),
    );
  }

  @Patch('service-accounts/:id')
  @RequirePermission('user.manage')
  async updateServiceAccount(
    @Param('id') id: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
  ): Promise<ServiceAccountResponse> {
    return accountView(
      await updateServiceAccount(
        this.infra.db,
        auth.principal,
        Uuid.parse(id),
        UpdateServiceAccountRequest.parse(body),
      ),
    );
  }

  @Get('service-accounts/:id/tokens')
  @RequirePermission('user.manage')
  async tokens(@Param('id') id: string, @Auth() auth: AuthContext): Promise<ApiTokenResponse[]> {
    return (await listApiTokens(this.infra.db, auth.principal.orgId, Uuid.parse(id))).map(tokenView);
  }

  /** The token is in this response only; it cannot be shown again. */
  @Post('service-accounts/:id/tokens')
  @RequirePermission('user.manage')
  @HttpCode(201)
  async createToken(
    @Param('id') id: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiTokenCreatedResponse> {
    const input = CreateApiTokenRequest.parse(body);
    let projectIds: string[] | null = null;
    if (input.projectKeys?.length) {
      projectIds = [];
      for (const key of input.projectKeys) {
        const project = await findProjectByKey(this.infra.db, auth.principal.orgId, key);
        if (!project || project.status === 'deleted')
          throw new DomainError('token.project_not_found', { key });
        projectIds.push(project.id);
      }
    }
    reply.header('cache-control', 'no-store');
    const { token, view } = await createApiToken(
      this.infra.db,
      this.secrets,
      auth.principal,
      Uuid.parse(id),
      {
        name: input.name,
        scopes: input.scopes,
        projectIds,
        expiresInDays: input.expiresInDays,
      },
    );
    return { token, apiToken: tokenView(view) };
  }

  @Delete('tokens/:id')
  @RequirePermission('user.manage')
  @HttpCode(204)
  async revokeToken(@Param('id') id: string, @Auth() auth: AuthContext): Promise<void> {
    await revokeApiToken(this.infra.db, auth.principal, Uuid.parse(id));
  }
}
