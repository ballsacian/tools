import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type Formatter = (source: string) => Promise<string>

export interface ResolvedFormatter {
  readonly format: Formatter
  /** How it was resolved — reported so a silent no-op is never a surprise. */
  readonly source: string
}

interface PrettierModule {
  resolveConfig: (file: string) => Promise<Record<string, unknown> | null>
  format: (source: string, options: Record<string, unknown>) => Promise<string>
}

/** Unwrap CJS-via-`import()`, which nests the real exports under `default`. */
function pickPrettier(imported: Record<string, unknown>): PrettierModule {
  if (typeof imported['format'] === 'function')
    return imported as unknown as PrettierModule
  const inner = imported['default']
  if (
    inner &&
    typeof (inner as Record<string, unknown>)['format'] === 'function'
  ) {
    return inner as PrettierModule
  }
  return imported as unknown as PrettierModule
}

/**
 * Load Prettier *from the project being checked*, not from this package.
 *
 * Bundling our own would compare the user's code against a different Prettier's
 * output, so a version bump on their side would read as drift in every
 * component at once. Their config is resolved the same way, from a file inside
 * the directory under test.
 *
 * Returns `null` when the project has no Prettier. That is not an error — it
 * means formatting is skipped, which is reported rather than silently assumed.
 */
export async function resolveFormatter(
  projectRoot: string,
  sampleFile: string,
): Promise<ResolvedFormatter | null> {
  let entry: string
  try {
    // `createRequire` needs a file path to resolve *from*; the file need not
    // exist. This walks the project's node_modules, not ours.
    const require = createRequire(path.join(projectRoot, 'noop.js'))
    entry = require.resolve('prettier')
  } catch {
    return null
  }

  let prettier: PrettierModule
  try {
    // Two interop hazards, both of which produce a *silently unformatted*
    // comparison — which would report every component as drifted:
    //
    // 1. A Windows absolute path (`E:\...`) is not a valid ESM specifier. Node
    //    rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME ("protocol 'e:'"), so
    //    it has to become a file:// URL. Exactly what the Windows CI job is for.
    // 2. `require.resolve` lands on Prettier's CJS entry, and `import()` of a
    //    CJS module puts the exports under `default` rather than spreading them
    //    as named exports. `mod.format` is then undefined.
    const imported = (await import(pathToFileURL(entry).href)) as Record<
      string,
      unknown
    >
    prettier = pickPrettier(imported)
  } catch {
    return null
  }
  if (typeof prettier.format !== 'function') return null

  let config: Record<string, unknown> | null
  try {
    config = await prettier.resolveConfig(sampleFile)
  } catch {
    config = null
  }

  const options = { ...(config ?? {}), parser: 'typescript' }
  return {
    format: (source) => prettier.format(source, options),
    source: config
      ? `prettier from the project, config resolved for ${path.basename(sampleFile)}`
      : 'prettier from the project, no config found (defaults)',
  }
}
