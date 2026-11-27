// Checks the app's modules: every name used is defined or imported, no module
// writes to a variable it imported, and nothing defined goes unused.
// Run through run.sh, which makes fixtures/browser-globals.json first.
import fs from 'node:fs';
const globals = JSON.parse(fs.readFileSync(new URL('./fixtures/browser-globals.json', import.meta.url)));
export default [{
  files: ['**/*.js'],
  languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals },
  rules: {
    'no-undef': 'error',
    'no-import-assign': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  },
}];
