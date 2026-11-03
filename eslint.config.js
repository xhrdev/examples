import { config } from '@skilbjo/config-rc';

export default [
  ...config,
  {
    ignores: [
      '.claude/**',
      'dev-resources/repl.cjs',
      'dist/**',
      'target/**',
      'venv/**',
    ],
  },
];
