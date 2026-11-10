import { expect, test, type Page } from '@playwright/test';

const VARIANTS = [
  { locale: 'en', dir: 'ltr', theme: 'light', title: 'Overview' },
  { locale: 'en', dir: 'ltr', theme: 'dark', title: 'Overview' },
  { locale: 'ar', dir: 'rtl', theme: 'light', title: 'نظرة عامة' },
  { locale: 'ar', dir: 'rtl', theme: 'dark', title: 'نظرة عامة' },
] as const;

const open = async (page: Page, locale: string, theme: string) => {
  await page.context().addCookies([{ name: 'qos-theme', value: theme, url: 'http://127.0.0.1:3100' }]);
  await page.goto(`/${locale}`);
};
const luminance = (rgb: string) => {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

for (const v of VARIANTS) {
  test(`shell renders in ${v.locale} / ${v.theme}`, async ({ page }) => {
    await open(page, v.locale, v.theme);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', v.locale);
    await expect(html).toHaveAttribute('dir', v.dir);
    await expect(html).toHaveAttribute('data-theme', v.theme);
    await expect(page.getByTestId('page-title')).toHaveText(v.title);

    // The sidebar sits at the start edge: left in LTR, right in RTL.
    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    const viewport = page.viewportSize()!;
    if (v.dir === 'ltr') expect(sidebar.x).toBe(0);
    else expect(Math.round(sidebar.x + sidebar.width)).toBe(viewport.width);

    // The theme really changes the surface: dark backgrounds are darker than their text.
    const colours = await page.evaluate(() => {
      const s = getComputedStyle(document.body);
      return { bg: s.backgroundColor, fg: s.color };
    });
    if (v.theme === 'dark') expect(luminance(colours.bg)).toBeLessThan(luminance(colours.fg));
    else expect(luminance(colours.bg)).toBeGreaterThan(luminance(colours.fg));

    // No horizontal overflow in either direction.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await expect(page).toHaveScreenshot(`shell-${v.locale}-${v.theme}.png`);
  });
}

test('root redirects to the default locale and unknown locales are 404', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/en$/);
  const res = await page.goto('/xx');
  expect(res?.status()).toBe(404);
});

test('status table shows every backend service, and unreachable ones are labelled', async ({ page }) => {
  await open(page, 'en', 'light');
  const rows = page.locator('[data-testid="status-table"] tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute('data-state', 'unreachable');
  await expect(rows.first()).toContainText('Unreachable');
});

test('command palette opens with the keyboard and closes with Escape', async ({ page }) => {
  await open(page, 'en', 'light');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeHidden();
  await page.keyboard.press('Control+K');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('theme choice applies at once and survives a reload', async ({ page }) => {
  await open(page, 'en', 'light');
  await page.getByTestId('theme-select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-select').selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
});

test('language switch keeps the user in the shell and flips direction', async ({ page }) => {
  await open(page, 'en', 'light');
  await page.getByRole('link', { name: 'العربية' }).click();
  await expect(page).toHaveURL(/\/ar$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('security headers are set on pages', async ({ request }) => {
  const res = await request.get('/en');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['x-powered-by']).toBeUndefined();
});
