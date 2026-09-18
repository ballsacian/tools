import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { operational } from './errors.js'
import { readJsonc } from './jsonc.js'

/** The subset of `components.json` this tool reads. */
export interface ComponentsJson {
  style?: string
  rsc?: boolean
  tsx?: boolean
  tailwind?: {
    config?: string
    css?: string
    baseColor?: string
    cssVariables?: boolean
    prefix?: string
  }
  aliases?: Record<string, string>
  registries?: Record<string, unknown>
  iconLibrary?: string
  /** Our own escape hatches. Absent on every project that does not need them. */
  drift?: DriftOverrides
}

export interface DriftOverrides {
  /** Files in `ui/` to skip entirely, as globs. */
  ignore?: string[]
  /** Registry origins beyond `ui.shadcn.com` that this project trusts. */
  registryAllowlist?: string[]
  formatter?: 'prettier' | 'none'
  /** Escape hatch for a `ui/` directory we could not resolve. */
  uiDir?: string
  /** Escape hatch for style detection, e.g. pinning `new-york-v4`. */
  registryStyle?: string
}

export interface ResolvedConfig {
  /** Directory containing `components.json`. All paths resolve from here. */
  readonly projectRoot: string
  readonly componentsJsonPath: string
  /** The `style` field as written, e.g. `new-york`. */
  readonly declaredStyle: string
  /** What the registry is actually addressed by, e.g. `new-york-v4`. */
  readonly registryStyle: string
  readonly tailwindVersion: 3 | 4
  /** How the Tailwind version was decided — surfaced in `--json`. */
  readonly tailwindVersionSource: string
  /** Absolute path to the resolved `ui/` directory. */
  readonly uiDir: string
  /** Which mechanism resolved `uiDir` — surfaced in `--json`. */
  readonly uiDirSource: string
  readonly aliases: Readonly<Record<string, string>>
  readonly tsx: boolean
  readonly rsc: boolean
  readonly registries: Readonly<Record<string, unknown>>
  readonly overrides: DriftOverrides
}

const MAX_WALK_UP = 12
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.output',
  'coverage',
])

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Locate every `components.json` worth checking, starting from `cwd`.
 *
 * Walking *up* finds the project you are standing in, which is the common case.
 * When that finds nothing we walk *down* instead, because `npx shadcn-drift` at
 * a monorepo root should still work — that is the invocation people will
 * actually type, and requiring `--cwd packages/app` to get any output at all
 * would undercut the whole zero-config premise.
 */
export async function findComponentsJson(cwd: string): Promise<string[]> {
  let dir = path.resolve(cwd)
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = path.join(dir, 'components.json')
    if (await isFile(candidate)) return [candidate]
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const found = await searchDown(path.resolve(cwd), 4)
  return found.sort()
}

async function searchDown(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'components.json') {
      results.push(path.join(dir, entry.name))
    } else if (
      entry.isDirectory() &&
      !SKIP_DIRS.has(entry.name) &&
      !entry.name.startsWith('.')
    ) {
      results.push(...(await searchDown(path.join(dir, entry.name), depth - 1)))
    }
  }
  return results
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  imports?: Record<string, unknown>
}

interface TsconfigJson {
  extends?: string
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
}

/**
 * Decide which major of Tailwind the project is on, because it selects the
 * registry style and therefore which component we compare against.
 *
 * The strongest signal is `components.json` itself: Tailwind v4 has no config
 * file, so the shadcn CLI writes `"config": ""`. A non-empty value means v3.
 */
async function detectTailwindVersion(
  projectRoot: string,
  components: ComponentsJson,
): Promise<{ version: 3 | 4; source: string }> {
  const configured = components.tailwind?.config
  if (typeof configured === 'string' && configured.trim() !== '') {
    return {
      version: 3,
      source: `components.json tailwind.config "${configured}"`,
    }
  }

  const declared = await findTailwindDependency(projectRoot)
  if (declared) {
    const major = /(\d+)/.exec(declared.range.replace(/^[\^~>=<\s]*/, ''))?.[1]
    if (major === '3') {
      return {
        version: 3,
        source: `${declared.where} tailwindcss ${declared.range}`,
      }
    }
    if (major && Number(major) >= 4) {
      return {
        version: 4,
        source: `${declared.where} tailwindcss ${declared.range}`,
      }
    }
  }

  return {
    version: 4,
    source:
      configured === ''
        ? 'components.json tailwind.config is empty (v4 has no config file)'
        : 'default (no tailwind.config and no tailwindcss dependency found)',
  }
}

async function findTailwindDependency(
  projectRoot: string,
): Promise<{ range: string; where: string } | null> {
  let dir = projectRoot
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const pkgPath = path.join(dir, 'package.json')
    if (await isFile(pkgPath)) {
      const pkg = await readJsonc<PackageJson>(pkgPath, 'package.json')
      const range =
        pkg.dependencies?.['tailwindcss'] ??
        pkg.devDependencies?.['tailwindcss']
      if (range)
        return {
          range,
          where: path.relative(projectRoot, pkgPath) || 'package.json',
        }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Registry style = declared style + Tailwind major.
 *
 * Not the same as `components.json`'s `style`. A project can declare
 * `new-york` and have its components come from `new-york-v4`, which are materially
 * different files. Comparing against the wrong one reports the entire directory
 * as drifted, which is the most confusing way this tool can be wrong — hence
 * the `registryStyle` override.
 */
export function registryStyleFor(
  declaredStyle: string,
  tailwindVersion: 3 | 4,
): string {
  if (tailwindVersion < 4) return declaredStyle
  return declaredStyle.endsWith('-v4') ? declaredStyle : `${declaredStyle}-v4`
}

interface AliasResolution {
  dir: string
  source: string
}

/**
 * Turn an alias like `#/components/ui` or `@/components/ui` into a real
 * directory, by asking the same things the bundler or Node would ask.
 */
async function resolveAliasToDir(
  alias: string,
  projectRoot: string,
): Promise<AliasResolution | null> {
  const viaTsconfig = await resolveViaTsconfig(alias, projectRoot)
  if (viaTsconfig) return viaTsconfig

  const viaImports = await resolveViaPackageImports(alias, projectRoot)
  if (viaImports) return viaImports

  // Last resort: strip the alias prefix and try the two conventional layouts.
  const rest = alias.replace(/^[^/]*\//, '')
  for (const candidate of [
    path.join(projectRoot, 'src', rest),
    path.join(projectRoot, rest),
  ]) {
    if (await isDirectory(candidate)) {
      return {
        dir: candidate,
        source: `convention (${path.relative(projectRoot, candidate)})`,
      }
    }
  }
  return null
}

async function loadTsconfigChain(
  projectRoot: string,
): Promise<{ paths: Record<string, string[]>; baseDir: string } | null> {
  let tsconfigPath: string | null = null
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(projectRoot, name)
    if (await isFile(candidate)) {
      tsconfigPath = candidate
      break
    }
  }
  if (!tsconfigPath) return null

  // Walk `extends` outward, nearest wins. A package-name extends (e.g.
  // `@tsconfig/node20`) is skipped rather than resolved: those presets do not
  // carry `paths`, and resolving them would drag in module resolution we do not
  // otherwise need.
  let current: string | null = tsconfigPath
  for (let i = 0; i < 8 && current; i++) {
    const cfg: TsconfigJson = await readJsonc<TsconfigJson>(
      current,
      'tsconfig.json',
    )
    const paths = cfg.compilerOptions?.paths
    if (paths) {
      const baseDir = path.resolve(
        path.dirname(current),
        cfg.compilerOptions?.baseUrl ?? '.',
      )
      return { paths, baseDir }
    }
    const next: string | undefined = cfg.extends
    current = next?.startsWith('.')
      ? path.resolve(path.dirname(current), next)
      : null
    if (current && !(await isFile(current))) current = `${current}.json`
    if (current && !(await isFile(current))) current = null
  }
  return null
}

async function resolveViaTsconfig(
  alias: string,
  projectRoot: string,
): Promise<AliasResolution | null> {
  const chain = await loadTsconfigChain(projectRoot)
  if (!chain) return null

  for (const [pattern, targets] of Object.entries(chain.paths)) {
    const matched = matchPattern(pattern, alias)
    if (matched === null) continue
    for (const target of targets) {
      const candidate = path.resolve(
        chain.baseDir,
        target.replace('*', matched),
      )
      if (await isDirectory(candidate)) {
        return {
          dir: candidate,
          source: `tsconfig paths "${pattern}" → "${target}"`,
        }
      }
    }
  }
  return null
}

async function resolveViaPackageImports(
  alias: string,
  projectRoot: string,
): Promise<AliasResolution | null> {
  const pkgPath = path.join(projectRoot, 'package.json')
  if (!(await isFile(pkgPath))) return null
  const pkg = await readJsonc<PackageJson>(pkgPath, 'package.json')
  if (!pkg.imports) return null

  for (const [pattern, rawTarget] of Object.entries(pkg.imports)) {
    const matched = matchPattern(pattern, alias)
    if (matched === null) continue
    const target =
      typeof rawTarget === 'string' ? rawTarget : firstStringTarget(rawTarget)
    if (!target) continue
    const candidate = path.resolve(projectRoot, target.replace('*', matched))
    if (await isDirectory(candidate)) {
      return {
        dir: candidate,
        source: `package.json imports "${pattern}" → "${target}"`,
      }
    }
  }
  return null
}

/** Conditional exports (`{ "default": "./src/*" }`) — take the first string. */
function firstStringTarget(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = firstStringTarget(nested)
      if (found) return found
    }
  }
  return null
}

/**
 * Match a `paths`/`imports` pattern against a specifier.
 * Returns what `*` captured, `''` for an exact match, or `null` for no match.
 */
function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === specifier ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null
  if (specifier.length < prefix.length + suffix.length) return null
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

/** Read and fully resolve one project's configuration. */
export async function resolveConfig(
  componentsJsonPath: string,
): Promise<ResolvedConfig> {
  const projectRoot = path.dirname(path.resolve(componentsJsonPath))
  const components = await readJsonc<ComponentsJson>(
    componentsJsonPath,
    'components.json',
  )

  const overrides = components.drift ?? {}
  const declaredStyle = components.style ?? 'new-york'
  const tailwind = await detectTailwindVersion(projectRoot, components)
  const registryStyle =
    overrides.registryStyle ?? registryStyleFor(declaredStyle, tailwind.version)

  const aliases = components.aliases ?? {}
  const uiAlias = aliases['ui']

  let uiDir: string
  let uiDirSource: string
  if (overrides.uiDir) {
    uiDir = path.resolve(projectRoot, overrides.uiDir)
    uiDirSource = 'components.json drift.uiDir'
    if (!(await isDirectory(uiDir))) {
      throw operational('drift.uiDir does not exist', [uiDir])
    }
  } else if (uiAlias) {
    const resolved = await resolveAliasToDir(uiAlias, projectRoot)
    if (!resolved) {
      throw operational(`could not resolve the "ui" alias to a directory`, [
        `alias: ${uiAlias}`,
        `project: ${projectRoot}`,
        'Checked tsconfig `paths`, package.json `imports`, and the src/ and ./ conventions.',
        'Set `drift.uiDir` in components.json, or pass --ui.',
      ])
    }
    uiDir = resolved.dir
    uiDirSource = resolved.source
  } else {
    const fallback = path.join(projectRoot, 'src/components/ui')
    if (!(await isDirectory(fallback))) {
      throw operational('components.json declares no "ui" alias', [
        `project: ${projectRoot}`,
        'Add `aliases.ui`, set `drift.uiDir`, or pass --ui.',
      ])
    }
    uiDir = fallback
    uiDirSource = 'default (src/components/ui)'
  }

  return {
    projectRoot,
    componentsJsonPath: path.resolve(componentsJsonPath),
    declaredStyle,
    registryStyle,
    tailwindVersion: tailwind.version,
    tailwindVersionSource: tailwind.source,
    uiDir,
    uiDirSource,
    aliases,
    tsx: components.tsx ?? true,
    rsc: components.rsc ?? false,
    registries: components.registries ?? {},
    overrides,
  }
}
