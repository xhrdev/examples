import { config } from '@skilbjo/config-rc';

export default [
  ...config,
  {
    ignores: ['dist/**', 'target/**'],
  },
];
