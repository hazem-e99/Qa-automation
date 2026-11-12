import { appendAudit, type Db } from '@qos/db';
import { listOrgAdmins } from '@qos/identity';
import { expiringConnections } from '@qos/integrations';
import { notify } from './notifications.js';

/**
 * Credential expiry warnings (M03-FR-05, M03-AC-07): every org admin gets at most one in-app
 * warning per connection per UTC day while a credential expires within 14 days, and each day that
 * produces a warning writes one audit entry. Safe to run as often as wanted: dedupe keys make
 * repeated runs on the same day no-ops.
 */
export async function checkCredentialExpiry(db: Db, now: Date = new Date()): Promise<{ warned: number }> {
  const day = now.toISOString().slice(0, 10);
  let warned = 0;
  for (const c of await expiringConnections(db, now)) {
    const daysLeft = Math.max(0, Math.ceil((c.credentialExpiresAt.getTime() - now.getTime()) / 86_400_000));
    await db.transaction(async (tx) => {
      let created = 0;
      for (const userId of await listOrgAdmins(tx, c.orgId)) {
        const isNew = await notify(tx, {
          userId,
          type: 'connection.credential.expiring',
          payload: {
            connectionId: c.id,
            displayName: c.displayName,
            daysLeft,
            expiresAt: c.credentialExpiresAt.toISOString(),
          },
          dedupeKey: `credential.expiring:${c.id}:${day}`,
        });
        if (isNew) created++;
      }
      if (created > 0) {
        warned += created;
        await appendAudit(tx, {
          orgId: c.orgId,
          actorType: 'system',
          actorId: 'credentials.expiry-check',
          action: 'connection.credential.expiring',
          targetType: 'connection',
          targetId: c.id,
          summary: { daysLeft, day, notified: created },
          source: 'worker',
        });
      }
    });
  }
  return { warned };
}
