// @ts-check
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.',
  outputDir: '/tmp/pw-results',
  retries: 0,
  reporter: [['json', { outputFile: '/tmp/pw-results/report.json' }], ['line']],
  use: {
    proxy: { server: 'http://squid:3128' },
    trace: 'retain-on-failure',
  },
});
