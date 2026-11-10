/**
 * Architecture fitness functions (doc 07 §9, rule 1). Run from the repository root:
 *   depcruise --config packages/config/dependency-cruiser.cjs apps packages
 * Paths are matched relative to the working directory.
 */
const FRAMEWORK_OR_INFRA =
  '(^|/)node_modules/(@nestjs|drizzle-orm|drizzle-kit|pg|pg-boss|fastify|pino)(/|$)|^(@nestjs/|drizzle-orm|pg-boss|fastify)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment: 'A module may use another module only through its public entry (index). No deep imports.',
      from: { path: '^packages/modules/([^/]+)/' },
      to: {
        path: '^packages/modules/([^/]+)/',
        pathNot: ['^packages/modules/$1/', '^packages/modules/[^/]+/(src|dist)/index\\.(ts|js|d\\.ts)$'],
      },
    },
    {
      name: 'domain-is-framework-free',
      severity: 'error',
      comment: 'Domain code has no framework, ORM, driver or adapter imports.',
      from: { path: '^packages/(kernel-domain/src|modules/[^/]+/src/domain)/' },
      to: {
        path: `${FRAMEWORK_OR_INFRA}|^packages/(adapters-[^/]+|db|kernel-infra|observability|modules/jobs)/`,
      },
    },
    {
      name: 'ports-and-contracts-are-pure',
      severity: 'error',
      comment: 'Ports and contracts describe shapes; they never import infrastructure.',
      from: { path: '^packages/(ports|contracts)/src/' },
      to: { path: `${FRAMEWORK_OR_INFRA}|^packages/(adapters-[^/]+|db|kernel-infra|modules)/` },
    },
    {
      name: 'modules-do-not-import-adapters',
      severity: 'error',
      comment: 'Core modules ask for capabilities through ports; only composition roots wire adapters.',
      from: { path: '^packages/modules/' },
      to: { path: '^packages/adapters-[^/]+/|^@qos/adapters-' },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', '/dist/'] },
    exclude: {
      path: [
        '/node_modules/',
        '\\.test\\.ts$',
        '/test/',
        '/fixtures/',
        '\\.config\\.(ts|js|cjs)$',
        '\\.d\\.ts$',
      ],
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
      extensions: ['.ts', '.js', '.d.ts'],
    },
  },
};
