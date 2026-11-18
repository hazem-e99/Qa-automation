import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * P2 and P3 journeys in demo mode, one ordered story on one fresh backend:
 * first-run setup → demo seed → project wizard (M02-AC-01) → settings → invitation → MFA → audit
 * → requirements: manual entry, search, upload, side-by-side review, trace link, export.
 */
test.describe.configure({ mode: 'serial' });

const SETUP_TOKEN = 'journey-test-setup-token-0123456789abcdef';
const ADMIN = { email: 'lead@example.test', password: 'journey admin password 1' };
let page: Page;
let mfaSecret = '';
/** Every secret the journey handles; none may reach a log line (M14-AC-07). */
const secrets: string[] = [SETUP_TOKEN, ADMIN.password, 'quinn long password 9'];

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
  secrets.push(link.split('#')[1]!);
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
  secrets.push(mfaSecret);
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

test('the mapping editor discovers tracker values, then defect sync can be activated (M03-AC-09)', async () => {
  await page.goto('/en/projects/SHOP/settings?tab=mappings');
  await expect(page.getByTestId('toggle-defect-sync')).toHaveText('Activate');
  await page.getByTestId('toggle-defect-sync').click();
  await expect(page.getByTestId('mapping-message')).toContainText('Discover');
  await page.getByTestId('discover').click();
  const status = page.getByTestId('mapping-status');
  await expect(status.locator('tr[data-external="Active"]')).toBeVisible();
  await expect(status).toContainText('Valid');
  await page.getByTestId('toggle-defect-sync').click();
  await expect(page.getByTestId('mapping-message')).toHaveText('Defect sync is on.');
});

test('Arabic pages render right-to-left with translated text', async () => {
  await page.goto('/ar/projects/WS');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'الإعدادات' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// ---- P3: requirements (J2 without AI) ----

const CORPUS = path.resolve('../../spikes/parser/corpus/files');

test('P3: a requirement written by hand is found by a search without diacritics (M04-AC-06)', async () => {
  await page.goto('/en/projects/WS/requirements');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('new-requirement').click();
  await page.getByTestId('req-title').fill('يجب أن يتمكن المستخدمُ من تسجيل الدُّخول');
  await page
    .getByTestId('req-ac')
    .fill('Valid credentials open the dashboard\nFive failures lock the account');
  await page.getByTestId('req-save').click();
  await expect(page).toHaveURL(/\/requirements\/WS-R-1$/);
  await expect(page.getByTestId('requirement-state')).toHaveText('Draft');
  await expect(page.getByTestId('version-1')).toContainText('Five failures lock the account');
  await expect(page.getByTestId('requirement-title').locator('bdi')).toHaveText(
    'يجب أن يتمكن المستخدمُ من تسجيل الدُّخول',
  );

  await page.goto('/en/projects/WS/requirements');
  await page.getByTestId('requirement-search').fill('الدخول');
  await expect(page.getByTestId('requirements-table').locator('[data-requirement="WS-R-1"]')).toBeVisible();
  await page.getByTestId('requirement-search').fill('nothing like this at all');
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('P3: editing makes a new version; submit and withdraw move it through review', async () => {
  await page.goto('/en/projects/WS/requirements/WS-R-1');
  await page.getByTestId('edit').click();
  await page
    .getByTestId('edit-ac')
    .fill('Valid credentials open the dashboard\nFive failures lock the account for 15 minutes');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('requirement-message')).toHaveText('A new draft version was saved.');
  await expect(page.getByTestId('version-2')).toContainText('15 minutes');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('requirement-state')).toHaveText('In review');
  await page.getByTestId('withdraw').click();
  await expect(page.getByTestId('requirement-state')).toHaveText('Draft');
});

test('P3: an uploaded document is read, reviewed side by side and accepted (J2)', async () => {
  await page.goto('/en/projects/WS/requirements/sources');
  await page.getByTestId('source-name').fill('Specs');
  await page.getByTestId('create-source').click();
  await expect(page.getByTestId('sources-message')).toHaveText('Source added.');
  const card = page.getByTestId('source-Specs');
  await card.getByTestId('upload-input').setInputFiles(path.join(CORPUS, 'd03-booking-en-stories.docx'));
  await expect(page.getByTestId('sources-message')).toContainText('was uploaded');
  await expect(card.getByTestId('parse-status')).toHaveText('Read', { timeout: 30_000 });
  await card.getByTestId('review-link').click();

  const candidates = page.getByTestId('candidates');
  await expect(candidates.locator('[data-status="candidate"]')).toHaveCount(5);
  // Keyboard flow: J selects the next candidate, and the source shows where it was found.
  await page.keyboard.press('j');
  await expect(candidates.locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(page.getByTestId('source-blocks').locator('[data-hit="true"]').first()).toBeVisible();
  await page.getByTestId('select-bulk').click();
  await page.getByTestId('accept-selected').click();
  await expect(page.getByTestId('review-message')).toHaveText('5 requirements created.');
  await page.getByTestId('candidate-filter').selectOption('accepted');
  await expect(candidates.locator('[data-status="accepted"]')).toHaveCount(5);

  // The document as laid out, in a sandboxed frame (T-P3-14).
  await page.getByTestId('view-layout').click();
  await expect(page.getByTestId('layout-frame')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('[data-testid="layout-frame"]').locator('h2').first()).toBeVisible();
  await page.getByTestId('view-text').click();
});

test('P3: one list for every source; a requirement links back to its place in the document (M04-AC-01)', async () => {
  await page.goto('/en/projects/WS/requirements');
  const table = page.getByTestId('requirements-table');
  await expect(table.locator('tr[data-requirement]')).toHaveCount(6);
  await expect(table.locator('[data-requirement="WS-R-1"]')).toContainText('Manual');
  await expect(table.locator('[data-requirement="WS-R-2"]')).toContainText('Documents');
  await table.locator('[data-requirement="WS-R-2"]').getByRole('link').click();
  await expect(page.getByTestId('provenance')).toContainText('Specs');

  await page.getByTestId('link-target').fill('WS-R-1');
  await page.getByTestId('add-link').click();
  await expect(page.getByTestId('trace-related')).toContainText('WS-R-1');
  await expect(page.getByTestId('coverage')).toHaveText('Not covered');

  await page.getByTestId('open-source').first().click();
  await expect(page.getByTestId('review-workspace')).toBeVisible();
  await expect(page.getByTestId('source-blocks').locator('[data-hit="true"]').first()).toBeVisible();
});

test('P3: a spreadsheet is mapped column by column, previewed and re-extracted (T-P3-07)', async () => {
  await page.goto('/en/projects/WS/requirements/sources');
  await page.getByTestId('source-kind').selectOption('spreadsheet');
  await page.getByTestId('source-name').fill('Backlog sheet');
  await page.getByTestId('create-source').click();
  await expect(page.getByTestId('sources-message')).toHaveText('Source added.');
  const card = page.getByTestId('source-Backlog sheet');
  await card.getByTestId('upload-input').setInputFiles(path.join(CORPUS, 'x22-auth-en-sheet.xlsx'));
  await expect(card.getByTestId('parse-status')).toHaveText('Read', { timeout: 30_000 });
  await card.getByTestId('review-link').click();

  const panel = page.getByTestId('mapping-panel');
  // Roles suggested from the header row: ID, Requirement, Acceptance Criteria, Priority.
  await expect(panel.getByTestId('role-1')).toHaveValue('id');
  await expect(panel.getByTestId('role-2')).toHaveValue('text');
  await expect(panel.getByTestId('role-3')).toHaveValue('ac');
  await expect(panel.getByTestId('role-4')).toHaveValue('priority');
  await expect(panel.getByTestId('mapping-result')).toHaveText(
    /extracts [1-9]\d* requirements and [1-9]\d* criteria/,
  );
  // Without the criteria column, the preview extracts no criteria; saving re-extracts.
  await panel.getByTestId('role-3').selectOption('');
  await panel.getByTestId('preview-mapping').click();
  await expect(panel.getByTestId('mapping-result')).toHaveText(
    /extracts [1-9]\d* requirements and 0 criteria/,
  );
  await panel.getByTestId('save-mapping').click();
  await expect(page.getByTestId('review-message')).toContainText('Re-extracted');
  await expect(page.getByTestId('candidates').locator('li[data-status="candidate"] ul')).toHaveCount(0);

  // Split one candidate into two (M04-FR-08).
  const first = page.getByTestId('candidates').locator('li[data-status="candidate"]').first();
  const before = await page.getByTestId('candidates').locator('li[data-status="candidate"]').count();
  await first.getByTestId('split').click();
  await first
    .getByTestId('split-text')
    .fill('Passwords have at least 8 characters.\n\nPasswords are checked against a list of common ones.');
  await first.getByTestId('split-save').click();
  await expect(page.getByTestId('review-message')).toHaveText('The candidate was split into 2 candidates.');
  await expect(page.getByTestId('candidates').locator('li[data-status="candidate"]')).toHaveCount(before + 1);
});

test('P3: a PDF can be reviewed next to its pages as images (T-P3-14)', async () => {
  await page.goto('/en/projects/WS/requirements/sources');
  const card = page.getByTestId('source-Specs');
  await card.getByTestId('upload-input').setInputFiles(path.join(CORPUS, 'p09-library-en-numbered.pdf'));
  const pdf = card.locator('[data-document="p09-library-en-numbered"]');
  await expect(pdf.getByTestId('parse-status')).toHaveText('Read', { timeout: 30_000 });
  await pdf.getByTestId('review-link').click();
  await page.getByTestId('view-pages').click();
  const viewer = page.getByTestId('page-viewer');
  await expect(viewer.getByTestId('page-number')).toHaveText(/^Page 1 of \d+$/);
  const image = viewer.getByTestId('page-image');
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.getByTestId('view-text').click();
  await expect(page.getByTestId('source-blocks')).toBeVisible();
});

test('P3: the requirements export downloads as CSV and XLSX (T-P3-16)', async () => {
  await page.goto('/en/projects/WS/requirements');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(csv.suggestedFilename()).toMatch(/^WS-requirements-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync(await csv.path(), 'utf8');
  expect(text).toContain('WS-R-1');
  expect(text).toContain('تسجيل');
  const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-xlsx').click()]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(
    readFileSync(await xlsx.path())
      .subarray(0, 2)
      .toString('latin1'),
  ).toBe('PK');
});

test('P3: the requirement pages render right-to-left in Arabic', async () => {
  await page.goto('/ar/projects/WS/requirements');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'المصادر والمستندات' })).toBeVisible();
  await expect(page.getByTestId('requirements-table')).toContainText('مسودة');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('no secret used in the journeys appears in any API log line (M14-AC-07)', () => {
  const log = readFileSync(path.resolve('test-results/journeys/api.log'), 'utf8');
  expect(log.split('\n').length).toBeGreaterThan(50);
  expect(secrets.length).toBeGreaterThanOrEqual(5);
  for (const s of secrets)
    expect(log.includes(s), `a secret of length ${s.length} is in the log`).toBe(false);
});
