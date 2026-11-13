import {
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  authorize,
  csrfTokenMatches,
  isPermissionKey,
  isProjectPermission,
  resolveApiToken,
  resolveSession,
  type SessionPolicy,
  type TokenScope,
} from '@qos/identity';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import type { Tx } from '@qos/db';
import type { SecretStore } from '@qos/ports';
import { findProjectByKey } from '@qos/projects';
import {
  ACCESS_METADATA,
  readCookie,
  SESSION_COOKIE,
  TOKEN_SCOPE_METADATA,
  type Access,
  type AuthedRequest,
} from './access.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: deny by default (BR-M13-1).
 *  1. A route without an access declaration is refused.
 *  2. Non-public routes need a valid session.
 *  3. State-changing requests need the session's CSRF token.
 *  4. Permission routes are checked against the role catalog; project routes against the
 *     caller's access to the project in the URL.
 */
export class PolicyGuard implements CanActivate {
  constructor(
    private readonly infra: CoreInfra,
    private readonly sessionPolicy: SessionPolicy,
    private readonly secrets: SecretStore<Tx> | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = Reflect.getMetadata(ACCESS_METADATA, context.getHandler()) as Access | undefined;
    if (!access) {
      this.infra.logger.error(
        { controller: context.getClass().name, handler: context.getHandler().name },
        'route has no access declaration; refusing',
      );
      throw new DomainError('route.undeclared');
    }
    if (access.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && /^bearer\s/i.test(authorization)) {
      return this.tokenAccess(context, req, access, authorization.slice(7).trim());
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const principal = await resolveSession(this.infra.db, token, this.sessionPolicy);
    if (!principal || !token) throw new UnauthorizedException();

    if (!SAFE_METHODS.has(req.method) && !csrfTokenMatches(token, req.headers['x-csrf-token'])) {
      throw new DomainError('csrf.invalid');
    }
    if (access.kind === 'permission') {
      if (!isPermissionKey(access.permission)) throw new DomainError('route.undeclared');
      if (access.scope === 'project') {
        if (!isProjectPermission(access.permission)) throw new DomainError('route.undeclared');
        const key = (req.params as Record<string, unknown> | undefined)?.key;
        const project =
          typeof key === 'string' ? await findProjectByKey(this.infra.db, principal.orgId, key) : null;
        // Unknown project and "not yours" look the same from outside (M13-AC-02).
        if (!project) throw new NotFoundException();
        const read = await authorize(this.infra.db, principal, 'project.read', project.id);
        if (!read.allowed) throw new NotFoundException();
        const decision = await authorize(this.infra.db, principal, access.permission, project.id);
        if (!decision.allowed) throw new DomainError('forbidden');
        req.qosProject = project;
      } else {
        const decision = await authorize(this.infra.db, principal, access.permission);
        if (!decision.allowed) throw new DomainError('forbidden');
      }
    }
    req.qosAuth = { principal, sessionToken: token };
    return true;
  }

  /**
   * API token path (M13-FR-04, BR-M13-6). Only routes that declare a token scope accept tokens;
   * the token must carry that scope, and a project route must name a project the token may use.
   * No CSRF check: a bearer token is never sent automatically by a browser.
   */
  private async tokenAccess(
    context: ExecutionContext,
    req: AuthedRequest,
    access: Access,
    raw: string,
  ): Promise<boolean> {
    const scope = Reflect.getMetadata(TOKEN_SCOPE_METADATA, context.getHandler()) as TokenScope | undefined;
    const principal = await resolveApiToken(this.infra.db, this.secrets, raw);
    if (!principal) throw new UnauthorizedException();
    if (!scope) throw new DomainError('token.route_not_allowed');
    if (!principal.scopes.includes(scope)) throw new DomainError('token.scope_missing', { scope });
    if (access.kind === 'permission' && access.scope === 'project') {
      const key = (req.params as Record<string, unknown> | undefined)?.key;
      const project =
        typeof key === 'string' ? await findProjectByKey(this.infra.db, principal.orgId, key) : null;
      // Outside the token's project restriction looks the same as a project that does not exist.
      if (!project || (principal.projectIds && !principal.projectIds.includes(project.id))) {
        throw new NotFoundException();
      }
      req.qosProject = project;
    }
    req.qosToken = principal;
    return true;
  }
}
