import type { ReactNode } from "react"

// An agent upgrading a dependency with radius in its loop. The note, the line and the verdict are
// radius's real output for zod 4.4.3 → 4.5.0 on a small project; the steps around them illustrate
// what an agent does with it.
export function AgentSession() {
  return (
    <div className="overflow-hidden rounded-xl border bg-fd-card text-left shadow-lg">
      <div className="flex items-center gap-1.5 border-b px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="ml-3 font-mono text-xs text-fd-muted-foreground">
          coding agent
        </span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <Line>
          <Dim>&gt;</Dim> Upgrade zod to 4.5 and make sure nothing breaks.
        </Line>
        <Line> </Line>
        <Step tool="Bash">pnpm up zod@4.5.0</Step>
        <Step tool="Bash">npx dep-radius --since HEAD --json</Step>
        <Line>
          {"  "}
          <Dim>└</Dim> <Yellow>exit 1</Yellow> zod 4.4.3 → 4.5.0{" "}
          <Yellow>review</Yellow>
        </Line>
        <Line>
          {"    "}
          <Cyan>4.5.0</Cyan> ⚠️ String length counts code points
        </Line>
        <Line>
          {"      "}src/feedback/schema.ts:5{" "}
          <Dim>z.string().min(10).max(2000)</Dim>
        </Line>
        <Step tool="Read">src/feedback/schema.ts</Step>
        <Step tool="Edit">
          src/feedback/schema.test.ts <Dim>+ five emoji under .min(10)</Dim>
        </Step>
        <Step tool="Bash">pnpm test src/feedback</Step>
        <Line>
          {"  "}
          <Dim>└</Dim> <Green>✓ 4 passed</Green>
        </Line>
        <Line> </Line>
        <Line>
          <Dim>●</Dim> .min(10) now counts an emoji as one character, so a
        </Line>
        <Line>{"  "}five-emoji message is rejected. Test added, behaviour</Line>
        <Line>{"  "}confirmed, upgrade done.</Line>
      </pre>
    </div>
  )
}

function Step({ tool, children }: { tool: string; children: ReactNode }) {
  return (
    <Line>
      <Green>●</Green> <B>{tool}</B> {children}
    </Line>
  )
}

function Line({ children }: { children: ReactNode }) {
  return <span className="block whitespace-pre">{children}</span>
}

function B({ children }: { children: ReactNode }) {
  return <span className="font-bold">{children}</span>
}

function Dim({ children }: { children: ReactNode }) {
  return <span className="text-fd-muted-foreground">{children}</span>
}

function Cyan({ children }: { children: ReactNode }) {
  return <span className="text-sky-600 dark:text-sky-400">{children}</span>
}

function Green({ children }: { children: ReactNode }) {
  return (
    <span className="text-emerald-600 dark:text-emerald-400">{children}</span>
  )
}

function Yellow({ children }: { children: ReactNode }) {
  return <span className="text-amber-600 dark:text-amber-400">{children}</span>
}
