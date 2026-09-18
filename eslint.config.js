import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The simulation must be bit-for-bit reproducible from (seed, ruleset, input log).
    // Any nondeterminism here silently desyncs clients from the server.
    files: ['packages/sim/**/*.ts', 'packages/ai/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Use a seeded RNG stream from @rampart/sim — the simulation must be deterministic.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Use the tick counter — the simulation must not read wall-clock time.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: 'The simulation must not read wall-clock time.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'tools/**/*.ts'],
    rules: { 'no-console': 'off', 'no-restricted-properties': 'off' },
  },
);
