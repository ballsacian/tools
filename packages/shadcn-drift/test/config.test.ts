import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findComponentsJson,
  registryStyleFor,
  resolveConfig,
} from '../src/config.js'
import { DriftError } from '../src/errors.js'
import { ExitCode } from '../src/exit-codes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = (name: string) => path.join(here, 'fixtures/projects', name)
const componentsJson = (name: string) =>
  path.join(project(name), 'components.json')

/** Compare paths without caring about separators — this suite runs on Windows too. */
const norm = (p: string) => p.split(path.sep).join('/')

describe('findComponentsJson', () => {
  it('walks up from a nested directory', async () => {
    const found = await findComponentsJson(
      path.join(project('tsconfig-paths'), 'src/components/ui'),
    )
    expect(found).toEqual([componentsJson('tsconfig-paths')])
  })

  it('finds both projects in a monorepo when the root has none', async () => {
    // `npx shadcn-drift` at a monorepo root is the invocation people will type.
    const found = await findComponentsJson(project('monorepo'))
    expect(found.map(norm)).toEqual([
      norm(path.join(project('monorepo'), 'packages/admin/components.json')),
      norm(path.join(project('monorepo'), 'packages/app/components.json')),
    ])
  })
})

describe('registryStyleFor', () => {
  it('appends -v4 for Tailwind 4', () => {
    expect(registryStyleFor('new-york', 4)).toBe('new-york-v4')
  })

  it('leaves the style alone for Tailwind 3', () => {
    expect(registryStyleFor('new-york', 3)).toBe('new-york')
  })

  it('does not double-suffix a style that already says v4', () => {
    expect(registryStyleFor('new-york-v4', 4)).toBe('new-york-v4')
  })
})

describe('resolveConfig — alias resolution', () => {
  it('resolves @/ through tsconfig paths', async () => {
    const config = await resolveConfig(componentsJson('tsconfig-paths'))
    expect(norm(config.uiDir)).toBe(
      norm(path.join(project('tsconfig-paths'), 'src/components/ui')),
    )
    expect(config.uiDirSource).toContain('tsconfig paths')
  })

  it('parses a tsconfig containing comments and a URL inside a string', async () => {
    // The fixture's tsconfig has `// Docs: https://...` above `paths`. A regex
    // comment-stripper eats from the `//` in `https://` and produces garbage,
    // which is why this package depends on a real JSONC parser.
    const config = await resolveConfig(componentsJson('tsconfig-paths'))
    expect(config.uiDirSource).toContain('@/*')
  })

  it('resolves #/ through package.json imports', async () => {
    const config = await resolveConfig(componentsJson('package-imports'))
    expect(norm(config.uiDir)).toBe(
      norm(path.join(project('package-imports'), 'src/components/ui')),
    )
    expect(config.uiDirSource).toContain('package.json imports')
  })

  it('follows tsconfig `extends` to find paths', async () => {
    const config = await resolveConfig(componentsJson('tsconfig-extends'))
    expect(norm(config.uiDir)).toBe(
      norm(path.join(project('tsconfig-extends'), 'src/components/ui')),
    )
  })

  it('falls back to the conventional location with no alias', async () => {
    const config = await resolveConfig(componentsJson('no-alias'))
    expect(norm(config.uiDir)).toBe(
      norm(path.join(project('no-alias'), 'src/components/ui')),
    )
    expect(config.uiDirSource).toContain('default')
  })

  it('honours the drift.uiDir escape hatch when the alias is unresolvable', async () => {
    const config = await resolveConfig(componentsJson('overrides'))
    expect(norm(config.uiDir)).toBe(
      norm(path.join(project('overrides'), 'weird/place/ui')),
    )
    expect(config.uiDirSource).toContain('drift.uiDir')
  })
})

describe('resolveConfig — style resolution', () => {
  it('appends -v4 when tailwind.config is empty', async () => {
    const config = await resolveConfig(componentsJson('tsconfig-paths'))
    expect(config.declaredStyle).toBe('new-york')
    expect(config.registryStyle).toBe('new-york-v4')
    expect(config.tailwindVersion).toBe(4)
  })

  it('keeps the bare style when tailwind.config names a file', async () => {
    const config = await resolveConfig(componentsJson('tailwind-v3'))
    expect(config.registryStyle).toBe('new-york')
    expect(config.tailwindVersion).toBe(3)
    expect(config.tailwindVersionSource).toContain('tailwind.config')
  })

  it('reads the tailwindcss dependency when components.json is silent', async () => {
    const config = await resolveConfig(componentsJson('package-imports'))
    expect(config.tailwindVersion).toBe(4)
  })

  it('lets drift.registryStyle pin the style', async () => {
    const config = await resolveConfig(componentsJson('overrides'))
    expect(config.registryStyle).toBe('new-york')
  })

  it('records how it decided, so a wrong answer is debuggable', async () => {
    const config = await resolveConfig(componentsJson('tsconfig-paths'))
    expect(config.tailwindVersionSource).toBeTruthy()
    expect(config.uiDirSource).toBeTruthy()
  })
})

describe('resolveConfig — failures', () => {
  it('reports malformed components.json as operational, not as a finding', async () => {
    // Exit 3, never 1: the tool could not form a verdict. Reporting this as
    // drift would be a lie about the user's code.
    await expect(resolveConfig(componentsJson('broken'))).rejects.toThrow(
      DriftError,
    )
    await expect(resolveConfig(componentsJson('broken'))).rejects.toMatchObject(
      {
        exitCode: ExitCode.OPERATIONAL,
      },
    )
  })

  it('names the file it could not parse', async () => {
    const error = await resolveConfig(componentsJson('broken')).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(DriftError)
    expect((error as DriftError).detail.join(' ')).toContain('components.json')
  })

  it('reports a missing components.json', async () => {
    await expect(
      resolveConfig(path.join(here, 'nope/components.json')),
    ).rejects.toMatchObject({
      exitCode: ExitCode.OPERATIONAL,
    })
  })
})

describe('resolveConfig — passthrough', () => {
  it('surfaces aliases verbatim for the normalizer to use', async () => {
    const config = await resolveConfig(componentsJson('tsconfig-paths'))
    expect(config.aliases).toMatchObject({
      ui: '@/components/ui',
      utils: '@/lib/utils',
    })
  })

  it('carries the registry allowlist override through', async () => {
    const config = await resolveConfig(componentsJson('overrides'))
    expect(config.overrides.registryAllowlist).toEqual(['registry.acme.dev'])
  })
})
