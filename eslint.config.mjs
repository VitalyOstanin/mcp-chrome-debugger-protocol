import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import preferDeMorganLaw from '@vitalyostanin/eslint-prefer-de-morgan-law';

export default [
  {
    ignores: ['src/generated/**', '**/*.cjs', 'dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.lint.json',
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
      globals: {
        // Node.js globals
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        // Jest globals
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        // CommonJS globals for .cjs files
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
        // TypeScript globals
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'prefer-de-morgan-law': {
        rules: {
          'prefer-de-morgan-law': preferDeMorganLaw,
        },
      },
    },
    rules: {
      // Обязательные правила из требований
      'eol-last': 'error', // Перевод строки в конце файла
      'no-trailing-spaces': 'error', // Отсутствие пробелов в концах строк

      // Общие правила качества кода
      'no-console': 'off', // Разрешаем console для логирования
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',

      // Правило для пустых строк перед return
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
      ],

      // Правила для упрощения условий и деструктуризации
      'prefer-destructuring': ['error', { 'object': true }],
      'object-shorthand': ['error', 'always'],
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      'no-extra-boolean-cast': 'error',
      'no-unneeded-ternary': 'error',

      // Дополнительные правила для современного синтаксиса
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',

      // Кастомные правила
      'prefer-de-morgan-law/prefer-de-morgan-law': 'error', // Применение закона де Моргана: !a || !b → !(a && b)
    },
  },
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      '*.log',
      'coverage/**',
      '.tmp/**',
      '.temp/**',
      'eslint.config.js',
      'jest.config.js',
      '**/*.d.ts',
      'src/generated/**', // Автогенерированные файлы
      'bin/**',
      'eslint-rules/**', // Кастомные правила используют CommonJS
      'scripts/**', // Скрипты используют CommonJS
      'tests/fixtures/test-app/dist/**', // Скомпилированные файлы тестового приложения
      'tests/fixtures/test-app/src/**', // TypeScript исходники тестового приложения не в tsconfig.lint.json
      'tests/fixtures/test-app-js/**', // JavaScript тестовое приложение
      'jest.config.integration.js', // Jest конфиг использует CommonJS
    ],
  },
];