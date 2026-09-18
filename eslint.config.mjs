// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Fixtures are sample *projects* fed to the resolver as data, plus
      // recorded registry payloads compared byte-for-byte. Linting them means
      // linting someone else's hypothetical app: a fixture deliberately
      // carries a vendored `eslint-disable` for a lint rule, and that
      // rule does not exist in this repo — an error about a file we deliberately
      // copied verbatim. Excluded here for the same reason as in
      // `.prettierignore` and the package `tsconfig.json`.
      '**/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Must stay last: turns off the stylistic rules Prettier owns.
  prettier,
)
