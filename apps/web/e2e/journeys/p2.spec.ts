import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * P2 journeys in demo mode, one ordered story on one fresh backend:
 * first-run setup → demo seed → project wizard (M02-AC-01) → settings → invitation → MFA → audit.
 */
test.describe.configure({ mode: 'serial' });

const SETUP_TOKEN = 'journey-test-setup-token-0123456789abcdef';
const ADMIN = { email: 'lead@example.test', password: 'journey admin password 1' };
let page: Page;
let mfaSecret = '';

/** RFC 6238 TOTP, independent of the code under test. */
function totp(secretB32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', key).update(msg).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test('signed-out visitors are sent to sign-in', async () => {
  await page.goto('/en');
  await expect(page).toHaveURL(/\/en\/login$/);
  await expect(page.getByTestId('page-title')).toHaveText('Sign in');
});

test('first-run setup creates the organization and signs the admin in', async () => {
  await page.goto('/en/setup');
  await page.getByTestId('setup-token').fill(SETUP_TOKEN);
  await page.getByTestId('org-name').fill('Journey Org');
  await page.getByTestId('display-name').fill('Lena Lead');
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByText('Welcome, Lena Lead.')).toBeVisible();
});

test('loading demo data creates the two demo projects', async () => {
  await page.getByTestId('load-demo').click();
  const list = page.getByTestId('project-list');
  await expect(list.locator('[data-project="SHOP"]')).toBeVisible();
  await expect(list.locator('[data-project="API"]')).toBeVisible();
  await expect(page.getByTestId('demo-offer')).toHaveCount(0);
});

test('the project wizard creates a bound, configured project end to end (M02-AC-01)', async () => {
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Web Shop');
  await expect(page.getByTestId('project-key')).toHaveValue('WS');
  await page.getByTestId('next').click();

  await page.getByTestId('template-builtin-web-app').check();
  await page.getByTestId('next').click();

  await page.getByTestId('pick-repository').selectOption({ label: 'Demo repository (active) — demo' });
  await expect(page.getByTestId('role-check-ok')).toBeVisible();
  await page.getByTestId('next').click();

  await page.getByTestId('pick-issue_tracker').selectOption({ label: 'Demo tracker (active) — demo' });
  await expect(page.getByTestId('role-check-ok')).toBeVisible();
  await page.getByTestId('next').click();

  await page.getByTestId('env-url').fill('https://staging.webshop.example.test');
  await page.getByTestId('next').click();
  await page.getByTestId('next').click(); // members: none yet

  await expect(page.getByTestId('review')).toContainText('Web app – standard');
  await page.getByTestId('create-project').click();

  await expect(page.getByTestId('wizard-done')).toContainText('Project WS was created.');
  await expect(page.getByTestId('wizard-problems')).toHaveCount(0);
  const health = page.getByTestId('binding-health');
  await expect(health.locator('tr[data-ok="true"]')).toHaveCount(2);

  await page.getByTestId('open-project').click();
  await expect(page.getByTestId('page-title')).toHaveText('Web Shop');
  await expect(page.getByTestId('project-overview')).toBeVisible();
  await expect(page.getByTestId('recent-activity')).toContainText('project.created');
});

test('settings show the template and save a change with a new version', async () => {
  await page.goto('/en/projects/WS/settings?tab=rules');
  const execution = page.getByTestId('section-execution');
  await expect(execution.getByLabel('Firefox')).toBeChecked();
  await page.getByTestId('quality-flakyThresholdPct').fill('3');
  await page.getByTestId('save-quality').click();
  await expect(page.getByTestId('section-quality')).toContainText('Saved as version 2.');

  await page.getByTestId('tab-environments').click();
  await expect(page.getByTestId('environments-table')).toContainText('staging.webshop.example.test');
});

test('an invited person accepts the link and lands in the project', async ({ browser }) => {
  await page.goto('/en/admin/users');
  await page.getByTestId('admin-tab-invitations').click();
  await page.getByTestId('invite-email').fill('quinn@example.test');
  await page.getByTestId('invite-project').selectOption('WS');
  await page.getByTestId('invite-role').selectOption('qa_engineer');
  await page.getByTestId('send-invite').click();
  const link = (await page.getByTestId('secret-value').textContent())!.trim();
  expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);

  const other = await browser.newPage();
  await other.goto(link);
  await expect(other.getByTestId('invite-page')).toContainText('quinn@example.test');
  await other.getByTestId('display-name').fill('Quinn QA');
  await other.getByTestId('password').fill('quinn long password 9');
  await other.getByTestId('confirm').fill('quinn long password 9');
  await other.getByTestId('submit').click();
  await expect(other).toHaveURL(/\/en$/);
  await expect(other.getByTestId('project-list').locator('[data-project="WS"]')).toBeVisible();
  await expect(other.getByTestId('project-list').locator('[data-project="SHOP"]')).toHaveCount(0);
  // Not an administrator: no user administration in the navigation.
  await expect(other.getByTestId('sidebar')).not.toContainText('Users');
  await other.close();

  await page.goto('/en/projects/WS/settings?tab=members');
  await expect(page.getByTestId('members-table').locator('[data-member="quinn@example.test"]')).toContainText(
    'QA engineer',
  );
});

test('MFA: enroll, sign out, and sign in with a code', async () => {
  await page.goto('/en/me');
  await page.getByTestId('mfa-enroll').click();
  mfaSecret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByTestId('mfa-confirm-code').fill(totp(mfaSecret));
  await page.getByTestId('mfa-confirm').click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();

  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/en\/login$/);
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('page-title')).toHaveText('Two-step verification');
  // The enrollment code's time step is used up; the next step's code is accepted (±1 step drift).
  await page.getByTestId('mfa-code').fill(totp(mfaSecret, Date.now() + 30_000));
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(/\/en$/);
});

test('the audit log lists what happened, newest first', async () => {
  await page.goto('/en/audit');
  const table = page.getByTestId('audit-table');
  await expect(table.locator('[data-action="identity.login"]').first()).toBeVisible();
  await expect(table.locator('[data-action="identity.mfa.enabled"]')).toHaveCount(1);
  await expect(table.locator('[data-action="identity.invitation.accepted"]')).toHaveCount(1);
});

test('the integration hub shows the demo connections and the retire impact', async () => {
  await page.goto('/en/integrations');
  await page.getByTestId('connections-table').getByRole('link', { name: 'Demo tracker' }).click();
  await expect(page.getByTestId('capabilities').locator('[data-ok="true"]').first()).toBeVisible();
  await page.getByTestId('retire-start').click();
  const impact = page.getByTestId('retire-impact');
  for (const key of ['SHOP', 'API', 'WS']) await expect(impact).toContainText(key);
});

test('Arabic pages render right-to-left with translated text', async () => {
  await page.goto('/ar/projects/WS');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'الإعدادات' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
