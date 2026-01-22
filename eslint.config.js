import { config } from '@skilbjo/config-rc';

export default [
  ...config,
  {
    ignores: ['dev-resources/repl.cjs', 'dist/**', 'target/**', 'venv/**'],
  },
];
