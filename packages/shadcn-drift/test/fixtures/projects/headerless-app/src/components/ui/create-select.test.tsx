// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CreateSelect } from '#/components/ui/create-select.tsx'

/**
 * A colocated test, which is the shape that exposed the bug: `ui/` is not
 * exclusively the shadcn CLI's, and a `*.test.tsx` next to the component it
 * tests is ordinary. It is not a registry component and must never be offered
 * a provenance header.
 */
describe('CreateSelect', () => {
  it('renders the create-new affordance', () => {
    render(<CreateSelect />)
    expect(screen.getByText('Create new…')).toBeDefined()
  })
})
