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
      // Mandatory rules from project requirements
      'eol-last': 'error', // Newline at end of file
      'no-trailing-spaces': 'error', // No trailing spaces

      // General code quality rules
      'no-console': 'off', // Allow console for logging
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',

      // Blank lines around returns and declarations
      'padding-line-between-statements': [
        'error',
        // Always add a blank line before return
        { blankLine: 'always', prev: '*', next: 'return' },
        // Always add a blank line before a declarations block
        { blankLine: 'always', prev: '*', next: ['const', 'let', 'var'] },
        // Always add a blank line after a declarations block
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        // And NEVER between adjacent declarations in a block
        // (placed LAST to override above rules for var→var pair)
        { blankLine: 'never', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
      ],

      // Rules to simplify conditionals and destructuring
      'prefer-destructuring': ['error', {
        'VariableDeclarator': {
          'array': false,
          'object': true
        },
        'AssignmentExpression': {
          'array': false,
          'object': false // don't force in assignments for flexibility
        }
      }, {
        'enforceForRenamedProperties': false // don't force for renamed properties
      }],
      'object-shorthand': ['error', 'always', {
        'ignoreConstructors': false,
        'avoidQuotes': true,
        'avoidExplicitReturnArrows': true
      }],
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      'no-extra-boolean-cast': 'error',
      'no-unneeded-ternary': 'error',

      // Modern TypeScript best practices
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/prefer-function-type': 'error', // Prefer function types over interfaces
      '@typescript-eslint/prefer-literal-enum-member': 'error', // Prefer literal enum members
      '@typescript-eslint/prefer-readonly': 'error', // Prefer readonly for immutable fields
      '@typescript-eslint/prefer-readonly-parameter-types': 'off', // Too strict for most cases
      '@typescript-eslint/prefer-reduce-type-parameter': 'error', // Prefer typed reduce
      '@typescript-eslint/prefer-return-this-type': 'error', // Prefer `this` return type in fluent APIs
      '@typescript-eslint/prefer-ts-expect-error': 'error', // Prefer @ts-expect-error over @ts-ignore
      '@typescript-eslint/prefer-enum-initializers': 'error', // Require initializer for all enum values
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'], // Prefer interface over type
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }], // Prefer type imports
      '@typescript-eslint/consistent-type-exports': 'error', // Consistent type exports
      '@typescript-eslint/method-signature-style': ['error', 'property'], // Method style in interfaces
      '@typescript-eslint/no-confusing-void-expression': 'error', // Avoid confusing void expressions
      '@typescript-eslint/no-meaningless-void-operator': 'error', // Avoid meaningless void operator
      '@typescript-eslint/no-unnecessary-condition': 'error', // Avoid unnecessary conditions
      '@typescript-eslint/no-unnecessary-type-assertion': 'error', // Avoid unnecessary type assertions
      '@typescript-eslint/strict-boolean-expressions': 'off', // May be too strict
      '@typescript-eslint/switch-exhaustiveness-check': 'error', // Check switch exhaustiveness
      
      // Modern JavaScript best practices
      'prefer-object-spread': 'error', // Prefer {...obj} over Object.assign()
      'prefer-arrow-callback': 'error', // Prefer arrow functions for callbacks
      'prefer-rest-params': 'error', // Prefer ...args over arguments
      'prefer-spread': 'error', // Prefer spread syntax over .apply()
      
      // Trailing comma rules for multiline lists
      'comma-dangle': ['error', {
        'arrays': 'always-multiline',     // in multiline arrays
        'objects': 'always-multiline',    // in multiline objects
        'imports': 'always-multiline',    // in multiline imports
        'exports': 'always-multiline',    // in multiline exports
        'functions': 'always-multiline'   // in multiline function args
      }],

      // Custom rules
      'prefer-de-morgan-law/prefer-de-morgan-law': 'error', // Apply De Morgan's law: !a || !b → !(a && b)
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
      'src/generated/**', // Auto-generated files
      'bin/**',
      'eslint-rules/**', // Custom rules use CommonJS
      'scripts/**', // Scripts use CommonJS
      'tests/fixtures/test-app/dist/**', // Compiled test app files
      'tests/fixtures/test-app/src/**', // Test app TS sources not in tsconfig.lint.json
      'tests/fixtures/test-app-js/**', // JavaScript test app
      'jest.config.integration.js', // Jest config uses CommonJS
    ],
  },
];
