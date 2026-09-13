// Three rings around a dot: the blast radius of an update, and the part of it that reaches you.
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" opacity="0.35" />
      <circle cx="12" cy="12" r="6" opacity="0.7" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  )
}
