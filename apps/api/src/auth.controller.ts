import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { LoginRequest, SetupRequest, type MeResponse, type PermissionsResponse } from '@qos/contracts';
import { csrfTokenFor, login, logout, orgPermissionsOf, setupFirstAdmin } from '@qos/identity';
import { DomainError } from '@qos/kernel-domain';
import { TokenBucketLimiter, type CoreInfra } from '@qos/kernel-infra';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, Authenticated, Public, SESSION_COOKIE, sessionCookie, type AuthContext } from './access.js';
import type { ApiConfig } from './config.js';
import { CONFIG, INFRA } from './tokens.js';

@Controller('api/v1')
export class AuthController {
  /** Login attempts per minute, per account and per client address (doc 21 §rate limiting). */
  private readonly byAccount: TokenBucketLimiter;
  private readonly byAddress: TokenBucketLimiter;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(INFRA) private readonly infra: CoreInfra,
  ) {
    const perMinute = config.LOGIN_ATTEMPTS_PER_MINUTE;
    this.byAccount = new TokenBucketLimiter({ ratePerSecond: perMinute / 60, burst: perMinute });
    this.byAddress = new TokenBucketLimiter({ ratePerSecond: perMinute / 60, burst: perMinute });
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

  @Post('auth/login')
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ csrfToken: string }> {
    const input = LoginRequest.parse(body);
    for (const decision of [
      this.byAddress.take(`ip:${req.ip}`),
      this.byAccount.take(`account:${input.email.trim().toLowerCase().slice(0, 320)}`),
    ]) {
      if (!decision.allowed) {
        throw new DomainError('auth.rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
      }
    }
    const policy = {
      idleMinutes: this.config.SESSION_IDLE_MINUTES,
      absoluteDays: this.config.SESSION_ABSOLUTE_DAYS,
    };
    const result = await login(
      this.infra.db,
      input,
      { ip: req.ip, ua: req.headers['user-agent'] ?? null },
      policy,
    );
    reply.header(
      'set-cookie',
      sessionCookie(result.token, policy.absoluteDays * 86_400, this.config.COOKIE_SECURE),
    );
    reply.header('cache-control', 'no-store');
    return { csrfToken: result.csrfToken };
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

  /** Org-scope permissions of the caller, for UI gating. Project permissions arrive with projects. */
  @Get('me/permissions')
  @Authenticated()
  permissions(@Auth() auth: AuthContext): PermissionsResponse {
    return { org: orgPermissionsOf(auth.principal) };
  }
}

export { SESSION_COOKIE };
