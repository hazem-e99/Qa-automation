import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  AcceptInvitationRequest,
  ChangePasswordRequest,
  InvitationTokenRequest,
  LoginRequest,
  MfaCodeRequest,
  MfaDisableRequest,
  MfaVerifyRequest,
  PasswordResetRequest,
  SetupRequest,
  UpdateProfileRequest,
  type InvitationLookupResponse,
  type LoginResponse,
  type MeResponse,
  type MfaEnrollResponse,
  type MfaRecoveryCodesResponse,
  type MfaStatusResponse,
  type PermissionsResponse,
  type UserResponse,
} from '@qos/contracts';
import type { Tx } from '@qos/db';
import {
  acceptInvitation,
  beginMfaEnrollment,
  changeOwnPassword,
  completePasswordReset,
  confirmMfaEnrollment,
  csrfTokenFor,
  disableOwnMfa,
  getUser,
  login,
  logout,
  lookupInvitation,
  mfaStatus,
  orgPermissionsOf,
  setupFirstAdmin,
  updateOwnProfile,
  verifyMfaLogin,
  type SessionIssued,
  type SessionPolicy,
  type UserSummary,
} from '@qos/identity';
import { DomainError } from '@qos/kernel-domain';
import { TokenBucketLimiter, type CoreInfra } from '@qos/kernel-infra';
import type { SecretStore } from '@qos/ports';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, Authenticated, Public, SESSION_COOKIE, sessionCookie, type AuthContext } from './access.js';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA, SECRETS } from './tokens.js';

export const userView = (u: UserSummary): UserResponse => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  status: u.status,
  orgRoles: [...u.orgRoles],
  locale: u.locale,
  timezone: u.timezone,
  mfaEnabled: u.mfaEnabled,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

@Controller('api/v1')
export class AuthController {
  /** Login and MFA attempts per minute, per account and per client address (doc 21 §rate limiting). */
  private readonly byAccount: TokenBucketLimiter;
  private readonly byAddress: TokenBucketLimiter;
  private readonly policy: SessionPolicy;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INFRA) private readonly infra: CoreInfra,
    @Inject(SECRETS) private readonly secrets: SecretStore<Tx> | null,
  ) {
    const perMinute = config.LOGIN_ATTEMPTS_PER_MINUTE;
    this.byAccount = new TokenBucketLimiter({ ratePerSecond: perMinute / 60, burst: perMinute });
    this.byAddress = new TokenBucketLimiter({ ratePerSecond: perMinute / 60, burst: perMinute });
    this.policy = { idleMinutes: config.SESSION_IDLE_MINUTES, absoluteDays: config.SESSION_ABSOLUTE_DAYS };
  }

  private limit(keys: string[]): void {
    for (const key of keys) {
      const decision = (key.startsWith('ip:') ? this.byAddress : this.byAccount).take(key);
      if (!decision.allowed) {
        throw new DomainError('auth.rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
      }
    }
  }

  private startSession(reply: FastifyReply, session: SessionIssued): { csrfToken: string } {
    reply.header(
      'set-cookie',
      sessionCookie(session.token, this.policy.absoluteDays * 86_400, this.config.COOKIE_SECURE),
    );
    reply.header('cache-control', 'no-store');
    return { csrfToken: session.csrfToken };
  }

  private client(req: FastifyRequest) {
    return { ip: req.ip, ua: req.headers['user-agent'] ?? null };
  }

  /**
   * First-run setup: creates the organization and its administrator. Needs the setup token from
   * the server's configuration and works only while no user exists.
   */
  @Post('setup')
  @Public()
  @HttpCode(201)
  async setup(
    @Body() body: unknown,
    @Headers('x-setup-token') presented: string | undefined,
  ): Promise<{ orgId: string; userId: string }> {
    const expected = this.config.SETUP_TOKEN;
    if (!expected) throw new NotFoundException(); // setup is not enabled on this server
    const a = Buffer.from(expected);
    const b = Buffer.from(typeof presented === 'string' ? presented : '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError('forbidden');
    return setupFirstAdmin(this.infra.db, SetupRequest.parse(body));
  }

  /** Password login. With MFA enabled, answers with a challenge instead of a session. */
  @Post('auth/login')
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const input = LoginRequest.parse(body);
    this.limit([`ip:${req.ip}`, `account:${input.email.trim().toLowerCase().slice(0, 320)}`]);
    const result = await login(this.infra.db, input, this.client(req), this.policy);
    if (result.kind === 'mfa_required') {
      reply.header('cache-control', 'no-store');
      return {
        mfaRequired: true,
        challengeToken: result.challengeToken,
        expiresAt: result.expiresAt.toISOString(),
      };
    }
    return this.startSession(reply, result);
  }

  /** Second login step: a TOTP code or a recovery code for the challenge from `auth/login`. */
  @Post('auth/mfa/verify')
  @Public()
  @HttpCode(200)
  async verifyMfa(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ csrfToken: string }> {
    const input = MfaVerifyRequest.parse(body);
    this.limit([`ip:${req.ip}`, `mfa:${input.challengeToken.slice(0, 16)}`]);
    return this.startSession(
      reply,
      await verifyMfaLogin(this.infra.db, this.secrets, input, this.client(req), this.policy),
    );
  }

  @Get('me/mfa')
  @Authenticated()
  mfa(@Auth() auth: AuthContext): Promise<MfaStatusResponse> {
    return mfaStatus(this.infra.db, auth.principal.userId);
  }

  /** Starts enrollment; the secret is shown once, for the authenticator app. */
  @Post('me/mfa/enroll')
  @Authenticated()
  @HttpCode(200)
  async enrollMfa(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MfaEnrollResponse> {
    reply.header('cache-control', 'no-store');
    return beginMfaEnrollment(this.infra.db, this.secrets, auth.principal);
  }

  @Post('me/mfa/confirm')
  @Authenticated()
  @HttpCode(200)
  async confirmMfa(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MfaRecoveryCodesResponse> {
    this.limit([`ip:${req.ip}`, `mfa-user:${auth.principal.userId}`]);
    reply.header('cache-control', 'no-store');
    const { code } = MfaCodeRequest.parse(body);
    return confirmMfaEnrollment(this.infra.db, this.secrets, auth.principal, code);
  }

  @Post('me/mfa/disable')
  @Authenticated()
  @HttpCode(204)
  async disableMfa(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    this.limit([`ip:${req.ip}`, `mfa-user:${auth.principal.userId}`]);
    await disableOwnMfa(this.infra.db, this.secrets, auth.principal, MfaDisableRequest.parse(body));
  }

  /** What the invitation page shows before sign-up. The token travels in the body, never the URL. */
  @Post('invitations/lookup')
  @Public()
  @HttpCode(200)
  async lookupInvitation(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<InvitationLookupResponse> {
    this.limit([`ip:${req.ip}`]);
    const r = await lookupInvitation(this.infra.db, InvitationTokenRequest.parse(body).token);
    return { ...r, expiresAt: r.expiresAt.toISOString() };
  }

  /** Accepts an invitation and signs the new user in. */
  @Post('invitations/accept')
  @Public()
  @HttpCode(200)
  async acceptInvitation(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ csrfToken: string }> {
    this.limit([`ip:${req.ip}`]);
    const input = AcceptInvitationRequest.parse(body);
    return this.startSession(
      reply,
      await acceptInvitation(this.infra.db, input, this.client(req), this.policy),
    );
  }

  /** Uses an admin-generated reset link. Every session of the user ends; they sign in again. */
  @Post('auth/password/reset')
  @Public()
  @HttpCode(204)
  async resetPassword(@Body() body: unknown, @Req() req: FastifyRequest): Promise<void> {
    this.limit([`ip:${req.ip}`]);
    await completePasswordReset(this.infra.db, PasswordResetRequest.parse(body));
  }

  @Post('auth/logout')
  @Authenticated()
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await logout(this.infra.db, auth.principal);
    reply.header('set-cookie', sessionCookie('', 0, this.config.COOKIE_SECURE));
  }

  @Get('me')
  @Authenticated()
  me(@Auth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): MeResponse {
    reply.header('cache-control', 'no-store');
    return {
      id: auth.principal.userId,
      email: auth.principal.email,
      displayName: auth.principal.displayName,
      orgRoles: [...auth.principal.orgRoles],
      csrfToken: csrfTokenFor(auth.sessionToken),
    };
  }

  /** The caller's own profile: name, language, time zone, MFA state. */
  @Get('me/profile')
  @Authenticated()
  async profile(@Auth() auth: AuthContext): Promise<UserResponse> {
    return userView(await getUser(this.infra.db, auth.principal.orgId, auth.principal.userId));
  }

  @Patch('me/profile')
  @Authenticated()
  async updateProfile(@Body() body: unknown, @Auth() auth: AuthContext): Promise<UserResponse> {
    return userView(await updateOwnProfile(this.infra.db, auth.principal, UpdateProfileRequest.parse(body)));
  }

  /** Changes the caller's password; their other sessions end. */
  @Post('me/password')
  @Authenticated()
  @HttpCode(204)
  async changePassword(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    this.limit([`ip:${req.ip}`, `account:${auth.principal.email}`]);
    await changeOwnPassword(this.infra.db, auth.principal, ChangePasswordRequest.parse(body));
  }

  /** Org-scope permissions of the caller, for UI gating. */
  @Get('me/permissions')
  @Authenticated()
  permissions(@Auth() auth: AuthContext): PermissionsResponse {
    return { org: orgPermissionsOf(auth.principal) };
  }
}

export { SESSION_COOKIE };
