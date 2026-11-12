import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { Uuid } from '@qos/contracts';
import {
  decide,
  getPreferences,
  isApprovalAction,
  listNotifications,
  listPolicies,
  markRead,
  myApprovals,
  setPolicy,
  setPreferences,
} from '@qos/governance';
import { DomainError } from '@qos/kernel-domain';
import type { CoreInfra } from '@qos/kernel-infra';
import type { Project } from '@qos/projects';
import { z } from 'zod';
import { Auth, Authenticated, CurrentProject, RequireProjectPermission, type AuthContext } from './access.js';
import { INFRA } from './tokens.js';

const DecisionRequest = z.object({ comment: z.string().max(2000).nullish() });
const MarkReadRequest = z.object({ ids: z.array(z.uuid()).max(200).optional() });
const PreferencesRequest = z.record(z.string(), z.boolean());

/** My notifications, my approvals, and project approval policies (M14-FR-04/05). */
@Controller('api/v1')
export class GovernanceController {
  constructor(@Inject(INFRA) private readonly infra: CoreInfra) {}

  @Get('me/notifications')
  @Authenticated()
  notifications(@Auth() auth: AuthContext, @Query('unread') unread?: string) {
    return listNotifications(this.infra.db, auth.principal.userId, { unreadOnly: unread === 'true' });
  }

  @Post('me/notifications/mark-read')
  @Authenticated()
  @HttpCode(200)
  async markRead(@Body() body: unknown, @Auth() auth: AuthContext) {
    const { ids } = MarkReadRequest.parse(body ?? {});
    return { marked: await markRead(this.infra.db, auth.principal.userId, ids) };
  }

  @Get('me/notification-preferences')
  @Authenticated()
  preferences(@Auth() auth: AuthContext) {
    return getPreferences(this.infra.db, auth.principal.userId);
  }

  @Put('me/notification-preferences')
  @Authenticated()
  setPreferences(@Body() body: unknown, @Auth() auth: AuthContext) {
    return setPreferences(this.infra.db, auth.principal.userId, PreferencesRequest.parse(body));
  }

  /** Pending requests the caller may decide. Eligibility comes from each request's policy snapshot. */
  @Get('me/approvals')
  @Authenticated()
  approvals(@Auth() auth: AuthContext) {
    return myApprovals(this.infra.db, auth.principal);
  }

  @Post('approvals/:id/approve')
  @Authenticated()
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AuthContext) {
    const { comment } = DecisionRequest.parse(body ?? {});
    return decide(this.infra.db, auth.principal, {
      requestId: Uuid.parse(id),
      decision: 'approve',
      comment: comment ?? null,
    });
  }

  @Post('approvals/:id/reject')
  @Authenticated()
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AuthContext) {
    const { comment } = DecisionRequest.parse(body ?? {});
    return decide(this.infra.db, auth.principal, {
      requestId: Uuid.parse(id),
      decision: 'reject',
      comment: comment ?? null,
    });
  }

  @Get('projects/:key/approval-policies')
  @RequireProjectPermission('project.read')
  policies(@CurrentProject() project: Project) {
    return listPolicies(this.infra.db, project.id);
  }

  @Put('projects/:key/approval-policies/:action')
  @RequireProjectPermission('project.settings.manage')
  setPolicy(
    @Param('action') action: string,
    @Body() body: unknown,
    @Auth() auth: AuthContext,
    @CurrentProject() project: Project,
  ) {
    if (!isApprovalAction(action)) throw new DomainError('approval.action_unknown');
    if (project.status === 'archived') throw new DomainError('project_archived');
    return setPolicy(this.infra.db, auth.principal, project.id, action, body);
  }
}
