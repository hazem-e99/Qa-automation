// Functional check through the egress proxy + isolation checks from inside the sandbox.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const net = require('node:net');

test('allow-listed target works through proxy (RTL page)', async ({ page }) => {
  await page.goto('http://target/');
  await expect(page.getByTestId('title')).toHaveText('صفحة الاختبار');
  await page.getByLabel('Search').fill('abc');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page.locator('#out')).toHaveText('ok:abc');
});

// Squid answers 403 and closes the connection; the client sometimes reports that as "aborted"
// with "← 403 Forbidden" in the call log. Both mean: denied by the proxy.
const denied = async (request, url) => {
  try { return (await request.get(url, { failOnStatusCode: false })).status() === 403; }
  catch (e) { return /403 Forbidden/.test(String(e.message)) && /ERR_ACCESS_DENIED/.test(String(e.message)); }
};

test('non-allow-listed host is denied by proxy', async ({ request }) => {
  expect(await denied(request, 'http://forbidden/')).toBe(true);
});

test('internet host is denied by proxy', async ({ request }) => {
  expect(await denied(request, 'http://example.com/')).toBe(true);
});

const tcp = (host, port) => new Promise(resolve => {
  const s = net.connect({ host, port, timeout: 2000 });
  s.on('connect', () => { s.destroy(); resolve('connected'); });
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  s.on('error', e => resolve(e.code));
});

test('isolation: no direct network, no docker socket, read-only rootfs, non-root', async () => {
  expect(await tcp('forbidden', 80)).not.toBe('connected');          // different network
  expect(await tcp('169.254.169.254', 80)).not.toBe('connected');    // metadata IP
  expect(await tcp('host.docker.internal', 2375)).not.toBe('connected');
  expect(fs.existsSync('/var/run/docker.sock')).toBe(false);
  expect(() => fs.writeFileSync('/usr/escape-test', 'x')).toThrow(); // read-only rootfs
  expect(process.getuid()).not.toBe(0);                               // pwuser
});
