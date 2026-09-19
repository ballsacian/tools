import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, type FetchLike } from '../../src/registry.js'

const registryDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/registry',
)

/**
 * A registry backed by recorded payloads.
 *
 * The suite must never touch the network: CI going red because ui.shadcn.com
 * had a bad day would train everyone to ignore it. Shared between the `check`
 * and `init` suites so both see the same recordings — `init` proposing a state
 * that `check` then disagrees with would be the tool contradicting itself, and
 * that is only a meaningful test if both read the same upstream.
 */
export const fixtureFetch: FetchLike = async (url) => {
  const ok = (body: string) => ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  })

  if (url.endsWith('/r/index.json')) {
    return ok(await readFile(path.join(registryDir, 'index.json'), 'utf8'))
  }

  const match = /\/r\/styles\/([^/]+)\/([^/]+)\.json$/.exec(url)
  if (match) {
    const file = path.join(
      registryDir,
      `${match[1] ?? ''}__${match[2] ?? ''}.json`,
    )
    try {
      return ok(await readFile(file, 'utf8'))
    } catch {
      // Exactly what the real registry does: a 404 status with an HTML body.
      return {
        ok: false,
        status: 404,
        text: () => readFile(path.join(registryDir, '404.html'), 'utf8'),
      }
    }
  }
  throw new Error(`unexpected fetch: ${url}`)
}

export const fixtureRegistry = (): Registry =>
  new Registry({ fetchImpl: fixtureFetch })
