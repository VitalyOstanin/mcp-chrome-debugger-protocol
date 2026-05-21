import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    // Single source of truth for ignored paths. Patterns:
    //   - dist/build outputs and node_modules: never lint generated/3rd-party files.
    //   - **/*.cjs and **/*.d.ts: CJS interop shims and emitted declaration files.
    //   - src/generated/**: machine-generated TS modules; rules don't apply.
    //   - bin/: shipped binaries.
    //   - scripts/**: mix of shell scripts (.sh, not parseable by ESLint) and one
    //     ESM helper (.mjs) deliberately exempt from project-wide strict TS rules.
    //   - tests/fixtures/test-app/{dist,src}/**: TS sources outside the main
    //     tsconfig (own build); tests/fixtures/test-app-js/**: vanilla JS.
    //   - eslint.config.js / jest.config.js / *.log / .tmp / .temp / coverage:
    //     editor- or runtime-only artifacts.
    // tests/integration/ and tests/utils/ are intentionally NOT ignored — they
    // are part of the main tsconfig.json and run the full TS rule set.
    ignores: [
      'src/generated/**',
      '**/*.cjs',
      '**/*.d.ts',
      'dist/**',
      'build/**',
      'node_modules/**',
      'coverage/**',
      '*.log',
      '.tmp/**',
      '.temp/**',
      'eslint.config.js',
      'jest.config.js',
      'bin/**',
      'eslint-rules/**',
      'scripts/**',
      'tests/fixtures/test-app/dist/**',
      'tests/fixtures/test-app/src/**',
      'tests/fixtures/test-app-js/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
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
        // CommonJS globals for .cjs files
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        // TypeScript globals
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
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
      // Project rule from CLAUDE.md: no `any` anywhere -- use unknown + type
      // guards, generics, or proper interfaces. The rule was previously implied
      // by review, now enforced at lint time.
      '@typescript-eslint/no-explicit-any': 'error',
      // Catch unawaited Promises that would otherwise swallow rejections or
      // race with the synchronous flow. Intentional fire-and-forget paths
      // must mark themselves with `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      
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

    },
  },
];
