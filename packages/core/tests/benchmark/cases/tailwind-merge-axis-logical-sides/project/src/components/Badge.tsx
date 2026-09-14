import type { ReactNode } from "react"
import { twMerge } from "tailwind-merge"

type BadgeProps = { className?: string; children: ReactNode }

export function Badge({ className, children }: BadgeProps) {
  return (
    <span className={twMerge("inline-flex items-center rounded-full ps-2 pe-3 text-xs", className)}>
      {children}
    </span>
  )
}
