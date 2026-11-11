import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '@qos/identity';
import type { Project } from '@qos/projects';
import type { FastifyRequest } from 'fastify';

/**
 * Access declarations (BR-M13-1). Every route handler carries exactly one of these.
 * A handler without a declaration is refused by the policy guard and fails the route inventory test.
 */
export type Access =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly permission: string; readonly scope: 'org' | 'project' };

export const ACCESS_METADATA = 'qos:access';

/** No session needed. Use only for health, login, first-run setup and signed links. */
export const Public = () => SetMetadata(ACCESS_METADATA, { kind: 'public' } satisfies Access);
/** Any signed-in user. */
export const Authenticated = () => SetMetadata(ACCESS_METADATA, { kind: 'authenticated' } satisfies Access);
/** A signed-in user holding this org- or platform-scope permission. */
export const RequirePermission = (permission: string) =>
  SetMetadata(ACCESS_METADATA, { kind: 'permission', permission, scope: 'org' } satisfies Access);
/**
 * A signed-in user holding this permission in the project named by the `:key` route parameter.
 * A caller who cannot even read the project gets 404, so project existence is never leaked.
 */
export const RequireProjectPermission = (permission: string) =>
  SetMetadata(ACCESS_METADATA, { kind: 'permission', permission, scope: 'project' } satisfies Access);

export interface AuthContext {
  readonly principal: Principal;
  /** Raw session token of this request, needed to derive the CSRF token. Never logged. */
  readonly sessionToken: string;
}
export type AuthedRequest = FastifyRequest & { qosAuth?: AuthContext; qosProject?: Project };

/** Injects the authentication context that the policy guard attached to the request. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().qosAuth;
  if (!auth) throw new Error('Auth() used on a route that is not authenticated');
  return auth;
});

/** Injects the project the policy guard resolved and authorized for this request. */
export const CurrentProject = createParamDecorator((_data: unknown, ctx: ExecutionContext): Project => {
  const project = ctx.switchToHttp().getRequest<AuthedRequest>().qosProject;
  if (!project) throw new Error('CurrentProject() used on a route without RequireProjectPermission');
  return project;
});

export const SESSION_COOKIE = 'qos_session';

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
