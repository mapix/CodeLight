export default [{
  files: ['**/*.mjs', 'public/**/*.js'],
  ignores: ['node_modules/**', 'research/**', 'data/**'],
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
  rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-eval': 'error', 'no-implied-eval': 'error' }
}];
