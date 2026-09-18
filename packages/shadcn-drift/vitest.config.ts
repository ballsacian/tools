import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The suite must never touch the network. Registry payloads are recorded
    // fixtures; the one live test is opt-in behind DRIFT_LIVE=1 and is excluded
    // from `pnpm test` so CI cannot go red because ui.shadcn.com had a bad day.
    exclude: process.env.DRIFT_LIVE ? [] : ['test/**/*.live.test.ts'],
  },
})
