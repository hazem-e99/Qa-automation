import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noPhysicalDirection from './packages/config/eslint-rules/no-physical-direction.js';
import noProviderLiterals from './packages/config/eslint-rules/no-provider-literals.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/migrations/**',
      '**/fixtures/**',
      'spikes/**',
      'docs/**',
      'var/**',
      '**/next-env.d.ts',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Entry points and CLIs may print to the console before a logger exists.
    files: [
      '**/src/main.ts',
      '**/src/*-cli.ts',
      'tools/cli/src/**',
      '**/src/export-json-schema.ts',
      '**/*.cjs',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
  },
  {
    // Fitness function: no provider names in core modules, except infrastructure mapping files.
    files: ['packages/modules/*/src/**/*.ts'],
    ignores: ['packages/modules/*/src/infrastructure/**', '**/*.test.ts'],
    plugins: { qos: { rules: { 'no-provider-literals': noProviderLiterals } } },
    rules: { 'qos/no-provider-literals': 'error' },
  },
  {
    // RTL lint: UI code uses logical direction utilities only.
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    plugins: { qosUi: { rules: { 'no-physical-direction': noPhysicalDirection } } },
    rules: { 'qosUi/no-physical-direction': 'error' },
  },
);
