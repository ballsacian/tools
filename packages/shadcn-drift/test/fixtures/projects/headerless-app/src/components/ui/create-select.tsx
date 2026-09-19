import * as React from 'react'

import { cn } from '#/lib/utils.ts'

/**
 * Not a registry component. Wraps a native select with a "create new" row, so
 * `init` has something in the directory that genuinely resolves to (ours).
 */
function CreateSelect({
  className,
  onCreate,
  children,
  ...props
}: React.ComponentProps<'select'> & { onCreate?: () => void }) {
  return (
    <select
      data-slot="create-select"
      className={cn('border-input h-9 rounded-md border px-3', className)}
      onChange={(event) => {
        if (event.target.value === '__create__') onCreate?.()
      }}
      {...props}
    >
      {children}
      <option value="__create__">Create new…</option>
    </select>
  )
}

export { CreateSelect }
