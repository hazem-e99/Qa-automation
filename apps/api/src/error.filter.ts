import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ApiError } from '@qos/contracts';
import { DomainError } from '@qos/kernel-domain';
import { currentCorrelationId, type Logger } from '@qos/observability';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

/** Domain codes that are not plain 422s. */
const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  'auth.invalid_credentials': 401,
  'auth.rate_limited': 429,
  'csrf.invalid': 403,
  forbidden: 403,
  'route.undeclared': 403,
  'setup.already_done': 409,
  project_archived: 409,
  'connection.not_found': 404,
  'approval.not_found': 404,
  'approval.not_pending': 409,
  'approval.already_decided': 409,
  'approval.not_eligible': 403,
  'approval.separation_of_duties': 403,
  'approval.action_unknown': 404,
  'webhook.not_found': 404,
  'environment.not_found': 404,
  'environment.name_taken': 409,
  'binding.not_found': 404,
  'binding.already_bound': 409,
  'settings.version_conflict': 409,
  'settings.section_unknown': 404,
  'connection.name_taken': 409,
  'connection.retired': 409,
  'secrets.unavailable': 503,
  'project.key_taken': 409,
  'project.invalid_state': 409,
  'member.role_above_own': 403,
  'member.cannot_change_own_role': 403,
  'member.user_not_found': 404,
  'member.not_found': 404,
  'member.last_lead': 409,
  'password.too_short': 400,
  'password.too_long': 400,
  'password.too_common': 400,
  'email.invalid': 400,
  'idempotency.key_invalid': 400,
  'idempotency.in_progress': 409,
  'idempotency.retry': 409,
  'operations.too_many_streams': 503,
  'auth.mfa_invalid': 401,
  'mfa.already_enabled': 409,
  'mfa.not_enrolling': 409,
  'mfa.not_enabled': 409,
  'user.not_found': 404,
  'user.exists': 409,
  'user.last_org_admin': 409,
  'user.cannot_deactivate_self': 409,
  'user.not_deactivated': 409,
  'user.not_active': 409,
  'invitation.invalid': 404,
  'invitation.not_found': 404,
  'invitation.closed': 409,
  'invitation.project_not_found': 404,
  'password_reset.invalid': 404,
  'service_account.not_found': 404,
  'service_account.name_taken': 409,
  'service_account.disabled': 409,
  'token.not_found': 404,
  'token.scope_invalid': 400,
  'token.route_not_allowed': 403,
  'token.scope_missing': 403,
  'token.project_not_found': 404,
  'demo.disabled': 404,
  'template.not_found': 404,
  'template.name_taken': 409,
  'template.builtin': 409,
  'audit.cursor_invalid': 400,
};

/**
 * Maps every error to the ApiError envelope: a stable code plus params. Internal details
 * (stack traces, SQL, driver messages) are logged and never returned to the caller.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, code, params } = this.classify(exception);
    if (status >= 500) this.logger.error({ err: exception }, 'unhandled error');
    const body: ApiError = { code, params, correlationId: currentCorrelationId() };
    if (status === 429 && typeof params.retryAfterSeconds === 'number') {
      void reply.header('retry-after', String(params.retryAfterSeconds));
    }
    void reply.status(status).send(body);
  }

  private classify(e: unknown): { status: number; code: string; params: ApiError['params'] } {
    if (e instanceof ZodError) {
      const fields = [...new Set(e.issues.map((i) => i.path.join('.') || '(body)'))].join(',');
      return { status: 400, code: 'request.invalid', params: { fields } };
    }
    if (e instanceof DomainError) {
      return { status: DOMAIN_STATUS[e.code] ?? 422, code: e.code, params: { ...e.params } };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      return { status, code: `http.${status}`, params: {} };
    }
    // Fastify errors (bad JSON, payload too large) carry a statusCode.
    const statusCode = (e as { statusCode?: unknown } | null)?.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return { status: statusCode, code: `http.${statusCode}`, params: {} };
    }
    return { status: 500, code: 'internal', params: {} };
  }
}
