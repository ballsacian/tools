import { DriftError, operational } from './errors.js'
import { ExitCode } from './exit-codes.js'

export const DEFAULT_REGISTRY = 'https://ui.shadcn.com'

/**
 * Origins trusted without being named in `drift.registryAllowlist`.
 *
 * A registry serves executable source code straight into your repo, so an
 * unexpected origin is the actual "fake shadcn" vector — not a component that
 * merely looks odd. Anything else has to be opted into explicitly.
 */
export const TRUSTED_ORIGINS = ['https://ui.shadcn.com']

export interface RegistryFile {
  path: string
  content?: string
  type?: string
}

export interface RegistryPayload {
  name: string
  type?: string
  dependencies?: string[]
  registryDependencies?: string[]
  files?: RegistryFile[]
}

export interface RegistryIndexEntry {
  name: string
  type?: string
}

export type FetchLike = (url: string) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export interface RegistryOptions {
  /** Base URL, default {@link DEFAULT_REGISTRY}. */
  baseUrl?: string
  /** Extra trusted origins from `drift.registryAllowlist`. */
  allowlist?: string[]
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike
}

/** Raised when a component is absent upstream — a finding, not a failure. */
export class UnknownComponentError extends DriftError {
  constructor(style: string, name: string, url: string) {
    super(`"${style}/${name}" does not exist in the registry`, {
      exitCode: ExitCode.AUTHENTICITY,
      detail: [
        url,
        'The header claims a component the registry has never served.',
        'Either the name is wrong, or this file is not shadcn at all.',
      ],
    })
    this.name = 'UnknownComponentError'
  }
}

export class Registry {
  readonly baseUrl: string
  private readonly allowlist: string[]
  private readonly fetchImpl: FetchLike
  private readonly cache = new Map<string, RegistryPayload | null>()
  private indexCache: string[] | null = null

  constructor(options: RegistryOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
    this.allowlist = [...TRUSTED_ORIGINS, ...(options.allowlist ?? [])]
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url))
    this.assertTrusted()
  }

  /**
   * Refuse an origin nobody opted into.
   *
   * Checked once at construction rather than per request, so a misconfigured
   * registry fails before a single byte of foreign code is fetched.
   */
  private assertTrusted(): void {
    let origin: string
    try {
      origin = new URL(this.baseUrl).origin
    } catch {
      throw operational(`registry base URL is not a valid URL`, [this.baseUrl])
    }
    const trusted = this.allowlist.some((entry) => {
      const normalized = entry.includes('://') ? entry : `https://${entry}`
      try {
        return new URL(normalized).origin === origin
      } catch {
        return false
      }
    })
    if (!trusted) {
      throw new DriftError(`untrusted registry origin "${origin}"`, {
        exitCode: ExitCode.AUTHENTICITY,
        detail: [
          'A registry serves source code directly into your repository.',
          `Add "${new URL(this.baseUrl).host}" to drift.registryAllowlist in components.json to trust it.`,
        ],
      })
    }
  }

  componentUrl(style: string, name: string): string {
    // The legacy, style-scoped form. Verified 2026-09-18: the flat
    // `/r/<name>.json` shape 404s, and the style segment is load-bearing —
    // `new-york` and `new-york-v4` are materially different components.
    return `${this.baseUrl}/r/styles/${style}/${name}.json`
  }

  /** Fetch one component. Throws {@link UnknownComponentError} on a 404. */
  async fetchComponent(style: string, name: string): Promise<RegistryPayload> {
    const url = this.componentUrl(style, name)
    const cached = this.cache.get(url)
    if (cached === null) throw new UnknownComponentError(style, name, url)
    if (cached) return cached

    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await this.fetchImpl(url)
    } catch (cause) {
      throw operational(`could not reach the registry`, [url], cause)
    }

    if (response.status === 404) {
      this.cache.set(url, null)
      throw new UnknownComponentError(style, name, url)
    }
    if (!response.ok) {
      throw operational(`registry returned ${String(response.status)}`, [url])
    }

    // Status first, body second. A 404 here returns ~35 KB of HTML, so parsing
    // before checking turns a clean finding into a JSON syntax error that reads
    // like a bug in this tool.
    const body = await response.text()
    let payload: RegistryPayload
    try {
      payload = JSON.parse(body) as RegistryPayload
    } catch (cause) {
      throw operational(
        `registry returned something that is not JSON`,
        [url],
        cause,
      )
    }

    this.cache.set(url, payload)
    return payload
  }

  /**
   * Every component name the registry knows, in one request.
   *
   * Makes the §9.1 existence check local for the whole directory instead of one
   * probe per file. Index entries carry no file content, so anything needing the
   * source still goes through {@link fetchComponent}.
   */
  async fetchIndex(): Promise<string[]> {
    if (this.indexCache) return this.indexCache
    const url = `${this.baseUrl}/r/index.json`
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await this.fetchImpl(url)
    } catch (cause) {
      throw operational('could not reach the registry index', [url], cause)
    }
    if (!response.ok) {
      throw operational(`registry index returned ${String(response.status)}`, [
        url,
      ])
    }
    const parsed = JSON.parse(await response.text()) as
      RegistryIndexEntry[] | { items?: RegistryIndexEntry[] }
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? [])
    this.indexCache = items.map((entry) => entry.name).filter(Boolean)
    return this.indexCache
  }
}

/**
 * Pull the component's own source out of a payload.
 *
 * Matching on the filename rather than the full path handles both shapes the
 * registry serves: `new-york-v4` nests its file under
 * `registry/new-york-v4/ui/button.tsx` while `new-york` uses a bare
 * `ui/button.tsx`.
 */
export function primaryFile(
  payload: RegistryPayload,
  name: string,
): RegistryFile {
  const files = payload.files ?? []
  const match = files.find(
    (file) =>
      file.path.endsWith(`/${name}.tsx`) ||
      file.path === `${name}.tsx` ||
      file.path.endsWith(`/${name}.ts`) ||
      file.path === `${name}.ts`,
  )
  if (!match?.content) {
    throw operational(`registry payload for "${name}" has no source for it`, [
      `files: ${files.map((f) => f.path).join(', ') || '(none)'}`,
    ])
  }
  return match
}

/**
 * Files in the payload that are *not* the component itself.
 *
 * `sidebar` ships `use-mobile`, for instance. These are not compared yet
 * (spec §14 Q2) but are reported, so a drifted companion is visible rather than
 * silently skipped the way the original script skipped it.
 */
export function companionFiles(
  payload: RegistryPayload,
  name: string,
): string[] {
  return (payload.files ?? [])
    .filter(
      (file) =>
        !file.path.endsWith(`${name}.tsx`) && !file.path.endsWith(`${name}.ts`),
    )
    .map((file) => file.path)
}
