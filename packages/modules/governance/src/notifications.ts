import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  notificationPreferences,
  notifications,
  sql,
  type Db,
  type Tx,
} from '@qos/db';
import { DomainError, uuidv7 } from '@qos/kernel-domain';

/** Notification types users can switch off. Anything not listed here is always delivered. */
export const NOTIFICATION_TYPES = [
  'approval.requested',
  'approval.decided',
  'connection.credential.expiring',
  'project.member.added',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const isNotificationType = (v: unknown): v is NotificationType =>
  typeof v === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(v);

export interface NotificationView {
  readonly id: string;
  readonly projectId: string | null;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface NewNotification {
  readonly userId: string;
  readonly projectId?: string | null;
  readonly type: NotificationType;
  /** Small, non-sensitive data for rendering: ids, names, counts. Never secrets or document text. */
  readonly payload: Record<string, unknown>;
  /** Same key for the same user → stored once (doc 10: ux(user_id, dedupe_key)). */
  readonly dedupeKey: string;
}

/**
 * Creates an in-app notification unless the user switched the type off. Returns whether a new
 * notification was stored (false for a duplicate key or a disabled type).
 */
export async function notify(db: Db | Tx, n: NewNotification): Promise<boolean> {
  const [pref] = await db
    .select({ inApp: notificationPreferences.inApp })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.userId, n.userId), eq(notificationPreferences.type, n.type)));
  if (pref && !pref.inApp) return false;
  const inserted = await db
    .insert(notifications)
    .values({
      id: uuidv7(),
      userId: n.userId,
      projectId: n.projectId ?? null,
      type: n.type,
      payload: n.payload,
      dedupeKey: n.dedupeKey.slice(0, 200),
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return inserted.length === 1;
}

export async function listNotifications(
  db: Db,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ items: NotificationView[]; unread: number }> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), opts.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
  const unread = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from governance.notifications where user_id = ${userId} and read_at is null`,
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      type: r.type,
      payload: r.payload as Record<string, unknown>,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    unread: unread.rows[0]?.n ?? 0,
  };
}

/** Marks the given notifications (or all, when `ids` is omitted) as read. Only the user's own. */
export async function markRead(db: Db, userId: string, ids?: readonly string[]): Promise<number> {
  const res = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, [...ids]) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  return res.length;
}

export async function getPreferences(db: Db, userId: string): Promise<Record<NotificationType, boolean>> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const byType = new Map(rows.map((r) => [r.type, r.inApp]));
  return Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, byType.get(t) ?? true])) as Record<
    NotificationType,
    boolean
  >;
}

export async function setPreferences(
  db: Db,
  userId: string,
  prefs: Readonly<Record<string, boolean>>,
): Promise<Record<NotificationType, boolean>> {
  const entries = Object.entries(prefs);
  for (const [type] of entries)
    if (!isNotificationType(type)) throw new DomainError('notification.type_unknown', { type });
  await db.transaction(async (tx) => {
    for (const [type, inApp] of entries) {
      await tx
        .insert(notificationPreferences)
        .values({ userId, type, inApp, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.type],
          set: { inApp, updatedAt: new Date() },
        });
    }
  });
  return getPreferences(db, userId);
}
