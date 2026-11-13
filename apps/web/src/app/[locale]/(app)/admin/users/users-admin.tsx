'use client';

import type {
  ApiTokenResponse,
  InvitationResponse,
  ServiceAccountResponse,
  UserResponse,
} from '@qos/contracts';
import { cn } from '@qos/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi, useErrorText, useSession } from '@/components/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Ltr,
  Notice,
  Select,
  Table,
  Td,
} from '@/components/ui';

const PROJECT_ROLES = [
  'qa_lead',
  'qa_engineer',
  'qc_reviewer',
  'developer',
  'project_manager',
  'viewer',
] as const;
const SCOPES = ['projects:read', 'automation:fire', 'runs:trigger', 'results:write'] as const;
type Msg = { tone: 'success' | 'danger'; text: string } | null;
const STATUS_TONE = { active: 'success', invited: 'accent', deactivated: 'neutral' } as const;

/** Shows a single-use link or token once, with a copy button (M13-FR-01/04). */
function Secret({ label, value }: { label: string; value: string }) {
  const t = useTranslations('admin');
  const [copied, setCopied] = useState(false);
  return (
    <Notice tone="warning" testId="one-time-secret">
      <p className="font-medium">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code
          className="flex-1 overflow-x-auto rounded border border-line bg-bg px-2 py-1 text-xs"
          dir="ltr"
          data-testid="secret-value"
        >
          {value}
        </code>
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
      <p className="mt-1 text-xs">{t('shownOnce')}</p>
    </Notice>
  );
}

/** Organization administration (T-P2-44, T-P2-43 UI): users, invitations, service accounts. */
export function UsersAdmin() {
  const t = useTranslations('admin');
  const r = useTranslations('roles');
  const [tab, setTab] = useState<'users' | 'invitations' | 'service'>('users');
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b border-line" aria-label={t('sections')}>
        {(['users', 'invitations', 'service'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            aria-current={tab === k ? 'page' : undefined}
            className={cn(
              'border-b-2 px-3 py-2 text-sm',
              tab === k ? 'border-accent font-medium text-accent' : 'border-transparent text-muted',
            )}
            data-testid={`admin-tab-${k}`}
          >
            {t(`tab_${k}`)}
          </button>
        ))}
      </nav>
      {tab === 'users' ? <UsersTab /> : null}
      {tab === 'invitations' ? <InvitationsTab roleLabel={r} /> : null}
      {tab === 'service' ? <ServiceAccountsTab /> : null}
    </div>
  );
}

function UsersTab() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const session = useSession();
  const [users, setUsers] = useState<UserResponse[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [link, setLink] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<UserResponse[]>('/users')
        .then(setUsers)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, errorText],
  );
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    setLink(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {msg ? (
        <Notice tone={msg.tone} testId="admin-message">
          {msg.text}
        </Notice>
      ) : null}
      {link ? <Secret label={t('resetLink')} value={link} /> : null}
      <Card title={t('users')}>
        <Table
          head={[t('person'), t('status'), t('orgRoles'), t('mfa'), t('lastLogin'), '']}
          testId="users-table"
        >
          {users.map((u) => {
            const self = u.id === session?.id;
            const admin = u.orgRoles.includes('org_admin');
            return (
              <tr key={u.id} data-user={u.email}>
                <Td>
                  {u.displayName}
                  <div className="text-xs text-muted" dir="ltr">
                    {u.email}
                  </div>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[u.status]}>{t(`status_${u.status}`)}</Badge>
                </Td>
                <Td>
                  {u.orgRoles.length
                    ? u.orgRoles.map((x) => <Badge key={x}>{t(`orgRole_${x}`)}</Badge>)
                    : '—'}
                </Td>
                <Td>
                  {u.mfaEnabled ? (
                    <Badge tone="success">{t('on')}</Badge>
                  ) : (
                    <span className="text-muted">{t('off')}</span>
                  )}
                </Td>
                <Td className="text-muted">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString(locale) : t('never')}
                </Td>
                <Td>
                  {self ? (
                    <span className="text-xs text-muted">{t('you')}</span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {u.status === 'deactivated' ? (
                        <Button
                          onClick={() =>
                            act(() => api(`/users/${u.id}/reactivate`, { method: 'POST' }), t('reactivated'))
                          }
                        >
                          {t('reactivate')}
                        </Button>
                      ) : (
                        <Button
                          tone="danger"
                          data-testid={`deactivate-${u.email}`}
                          onClick={() =>
                            window.confirm(t('confirmDeactivate', { name: u.displayName })) &&
                            act(() => api(`/users/${u.id}/deactivate`, { method: 'POST' }), t('deactivated'))
                          }
                        >
                          {t('deactivate')}
                        </Button>
                      )}
                      {u.status === 'active' ? (
                        <Button
                          onClick={() =>
                            act(
                              () => api(`/users/${u.id}`, { method: 'PATCH', body: { orgAdmin: !admin } }),
                              t('rolesSaved'),
                            )
                          }
                        >
                          {admin ? t('removeAdmin') : t('makeAdmin')}
                        </Button>
                      ) : null}
                      {u.status === 'active' ? (
                        <Button
                          onClick={async () => {
                            try {
                              const res = await api<{ url: string }>(`/users/${u.id}/password-reset`, {
                                method: 'POST',
                              });
                              setMsg(null);
                              setLink(res.url);
                            } catch (e) {
                              setMsg({ tone: 'danger', text: errorText(e) });
                            }
                          }}
                        >
                          {t('resetPassword')}
                        </Button>
                      ) : null}
                      {u.mfaEnabled ? (
                        <Button
                          onClick={() =>
                            window.confirm(t('confirmMfaReset')) &&
                            act(() => api(`/users/${u.id}/mfa/reset`, { method: 'POST' }), t('mfaResetDone'))
                          }
                        >
                          {t('resetMfa')}
                        </Button>
                      ) : null}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </div>
  );
}

function InvitationsTab({ roleLabel }: { roleLabel: (k: string) => string }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [rows, setRows] = useState<InvitationResponse[]>([]);
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [link, setLink] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<InvitationResponse[]>('/invitations')
        .then(setRows)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, errorText],
  );
  useEffect(() => {
    void load();
    api<{ key: string; name: string }[]>('/projects')
      .then(setProjects)
      .catch(() => undefined);
  }, [api, load]);

  const invite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const projectKey = String(f.get('projectKey') ?? '');
    setMsg(null);
    setLink(null);
    try {
      const res = await api<{ link: { url: string } }>('/invitations', {
        method: 'POST',
        body: {
          email: String(f.get('email') ?? ''),
          displayName: String(f.get('displayName') ?? '') || undefined,
          orgRole: f.get('orgAdmin') === 'on' ? 'org_admin' : null,
          projectKey: projectKey || null,
          projectRole: projectKey ? String(f.get('projectRole') ?? 'qa_engineer') : null,
        },
      });
      setLink(res.link.url);
      form.reset();
      await load();
    } catch (err) {
      setMsg({ tone: 'danger', text: errorText(err) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {link ? <Secret label={t('inviteLink')} value={link} /> : null}
      <Card title={t('invite')}>
        <form onSubmit={invite} className="grid gap-3 md:grid-cols-2">
          <Field label={t('email')}>
            <Input name="email" type="email" required dir="ltr" data-testid="invite-email" />
          </Field>
          <Field label={t('displayName')}>
            <Input name="displayName" maxLength={100} />
          </Field>
          <Field label={t('project')} hint={t('projectHint')}>
            <Select name="projectKey" data-testid="invite-project">
              <option value="">{t('noProject')}</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('projectRole')}>
            <Select name="projectRole" defaultValue="qa_engineer" data-testid="invite-role">
              {PROJECT_ROLES.map((x) => (
                <option key={x} value={x}>
                  {roleLabel(x)}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" name="orgAdmin" /> {t('inviteAsAdmin')}
          </label>
          <p className="text-xs text-muted md:col-span-2">{t('inviteHint')}</p>
          <div className="md:col-span-2">
            <Button tone="primary" type="submit" data-testid="send-invite">
              {t('createInvite')}
            </Button>
          </div>
        </form>
      </Card>
      <Card title={t('invitations')}>
        {rows.length === 0 ? (
          <EmptyState title={t('noInvitations')} />
        ) : (
          <Table head={[t('email'), t('status'), t('expires'), '']} testId="invitations-table">
            {rows.map((i) => (
              <tr key={i.id} data-invitation={i.email}>
                <Td>
                  <Ltr>{i.email}</Ltr>
                </Td>
                <Td>
                  <Badge
                    tone={i.status === 'pending' ? 'accent' : i.status === 'accepted' ? 'success' : 'neutral'}
                  >
                    {t(`inv_${i.status}`)}
                  </Badge>
                </Td>
                <Td className="text-muted">{new Date(i.expiresAt).toLocaleString(locale)}</Td>
                <Td>
                  {i.status === 'pending' || i.status === 'expired' ? (
                    <div className="flex gap-2">
                      <Button
                        onClick={async () => {
                          try {
                            const res = await api<{ link: { url: string } }>(`/invitations/${i.id}/resend`, {
                              method: 'POST',
                            });
                            setLink(res.link.url);
                            await load();
                          } catch (e) {
                            setMsg({ tone: 'danger', text: errorText(e) });
                          }
                        }}
                      >
                        {t('resend')}
                      </Button>
                      <Button
                        tone="danger"
                        onClick={async () => {
                          try {
                            await api(`/invitations/${i.id}`, { method: 'DELETE' });
                            await load();
                          } catch (e) {
                            setMsg({ tone: 'danger', text: errorText(e) });
                          }
                        }}
                      >
                        {t('revoke')}
                      </Button>
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function ServiceAccountsTab() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const api = useApi();
  const errorText = useErrorText();
  const [accounts, setAccounts] = useState<ServiceAccountResponse[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ApiTokenResponse[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const load = useCallback(
    () =>
      api<ServiceAccountResponse[]>('/service-accounts')
        .then(setAccounts)
        .catch((e) => setMsg({ tone: 'danger', text: errorText(e) })),
    [api, errorText],
  );
  const loadTokens = useCallback(
    (id: string) =>
      api<ApiTokenResponse[]>(`/service-accounts/${id}/tokens`)
        .then(setTokens)
        .catch(() => setTokens([])),
    [api],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (open) void loadTokens(open);
  }, [open, loadTokens]);

  const fail = (e: unknown) => setMsg({ tone: 'danger', text: errorText(e) });

  return (
    <div className="flex flex-col gap-4">
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {secret ? <Secret label={t('tokenCreated')} value={secret} /> : null}
      <Card title={t('newServiceAccount')}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            try {
              await api('/service-accounts', {
                method: 'POST',
                body: { name: String(f.get('name') ?? ''), description: String(f.get('description') ?? '') },
              });
              form.reset();
              await load();
            } catch (err) {
              fail(err);
            }
          }}
        >
          <Field label={t('saName')} hint={t('saNameHint')}>
            <Input
              name="name"
              required
              pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
              dir="ltr"
              data-testid="sa-name"
            />
          </Field>
          <Field label={t('description')} className="min-w-60 flex-1">
            <Input name="description" maxLength={500} />
          </Field>
          <Button tone="primary" type="submit" data-testid="create-sa">
            {t('create')}
          </Button>
        </form>
      </Card>
      <Card title={t('serviceAccounts')}>
        {accounts.length === 0 ? (
          <EmptyState title={t('noServiceAccounts')} />
        ) : (
          <Table head={[t('saName'), t('owner'), t('status'), t('tokens'), '']} testId="sa-table">
            {accounts.map((a) => (
              <tr key={a.id} data-sa={a.name}>
                <Td>
                  <Ltr>{a.name}</Ltr>
                  <div className="text-xs text-muted">{a.description}</div>
                </Td>
                <Td>
                  {a.owner.displayName}
                  {a.needsReassignment ? (
                    <div>
                      <Badge tone="warning">{t('needsOwner')}</Badge>
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={a.status === 'active' ? 'success' : 'neutral'}>{t(`sa_${a.status}`)}</Badge>
                </Td>
                <Td>{a.activeTokens}</Td>
                <Td>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => setOpen(open === a.id ? null : a.id)}
                      data-testid={`sa-tokens-${a.name}`}
                    >
                      {t('manageTokens')}
                    </Button>
                    <Button
                      tone={a.status === 'active' ? 'danger' : 'secondary'}
                      onClick={() =>
                        api(`/service-accounts/${a.id}`, {
                          method: 'PATCH',
                          body: { status: a.status === 'active' ? 'disabled' : 'active' },
                        })
                          .then(load)
                          .catch(fail)
                      }
                    >
                      {a.status === 'active' ? t('disable') : t('enable')}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open ? (
        <Card
          title={t('tokensFor', { name: accounts.find((a) => a.id === open)?.name ?? '' })}
          testId="tokens"
        >
          <form
            className="mb-4 grid gap-3 md:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const keys = String(f.get('projectKeys') ?? '')
                .split(/[\s,]+/)
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean);
              try {
                const res = await api<{ token: string }>(`/service-accounts/${open}/tokens`, {
                  method: 'POST',
                  body: {
                    name: String(f.get('name') ?? ''),
                    scopes: f.getAll('scopes').map(String),
                    projectKeys: keys.length ? keys : null,
                    expiresInDays: Number(f.get('days') ?? 90),
                  },
                });
                setSecret(res.token);
                form.reset();
                await loadTokens(open);
                await load();
              } catch (err) {
                fail(err);
              }
            }}
          >
            <Field label={t('tokenName')}>
              <Input name="name" required maxLength={100} data-testid="token-name" />
            </Field>
            <Field label={t('expiresDays')} hint={t('expiresDaysHint')}>
              <Input name="days" type="number" min={1} max={365} defaultValue={90} required />
            </Field>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 font-medium">{t('scopes')}</legend>
              {SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1">
                  <input type="checkbox" name="scopes" value={s} defaultChecked={s === 'projects:read'} />{' '}
                  <Ltr>{s}</Ltr>
                </label>
              ))}
            </fieldset>
            <Field label={t('projectKeys')} hint={t('projectKeysHint')}>
              <Input name="projectKeys" dir="ltr" />
            </Field>
            <div className="md:col-span-2">
              <Button tone="primary" type="submit" data-testid="create-token">
                {t('createToken')}
              </Button>
            </div>
          </form>
          {tokens.length === 0 ? (
            <EmptyState title={t('noTokens')} />
          ) : (
            <Table head={[t('tokenName'), t('token'), t('scopes'), t('expires'), t('lastUsed'), '']}>
              {tokens.map((k) => (
                <tr key={k.id}>
                  <Td>{k.name}</Td>
                  <Td>
                    <Ltr>{k.display}</Ltr>
                  </Td>
                  <Td>
                    {k.scopes.map((s) => (
                      <div key={s}>
                        <Ltr>{s}</Ltr>
                      </div>
                    ))}
                  </Td>
                  <Td className="text-muted">{new Date(k.expiresAt).toLocaleDateString(locale)}</Td>
                  <Td className="text-muted">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString(locale) : t('never')}
                  </Td>
                  <Td>
                    {k.revokedAt ? (
                      <Badge>{t('revoked')}</Badge>
                    ) : (
                      <Button
                        tone="danger"
                        onClick={() =>
                          api(`/tokens/${k.id}`, { method: 'DELETE' })
                            .then(() => loadTokens(open))
                            .catch(fail)
                        }
                      >
                        {t('revoke')}
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}
    </div>
  );
}
