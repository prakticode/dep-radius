import type { ReactNode } from "react"

// A brief as the terminal prints it, drawn with spans so it stays sharp and selectable.
export function Terminal() {
  return (
    <div className="overflow-hidden rounded-xl border bg-fd-card text-left shadow-lg">
      <div className="flex items-center gap-1.5 border-b px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="ml-3 font-mono text-xs text-fd-muted-foreground">
          npx dep-radius
        </span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <Line>
          <B>schemakit</B> 3.1.4 → 3.2.0 minor <Dim>published 3d ago</Dim>{" "}
          <Yellow>REVIEW</Yellow>
        </Line>
        <Line> surface changes ......... 12</Line>
        <Line> changes you touch ....... 0</Line>
        <Line>
          {" "}
          notes mentioning you .... 1 <Dim>of 18</Dim>
        </Line>
        <Line> </Line>
        <Line>
          {" "}
          <Cyan>3.2.0</Cyan> The email pattern no longer accepts quoted local
          parts
        </Line>
        <Line>
          {"   "}
          <Dim>you use: email</Dim>
        </Line>
        <Line>{"   "}src/signup/schema.ts:14</Line>
        <Line>
          {"   "}src/billing/contact.ts:9 <Dim>(via src/lib/validation.ts)</Dim>
        </Line>
        <Line> </Line>
        <Line>
          <Green>quiet</Green> (31) <Dim>merge without reading</Dim>
        </Line>
        <Line>
          {" "}
          <Dim>react, vitest, date-fns and 28 more</Dim>
        </Line>
        <Line> </Line>
        <Line>
          <B>38 with an update</B> <Green>31 quiet</Green> ·{" "}
          <Yellow>7 review</Yellow> · <Red>0 blocked</Red>
        </Line>
      </pre>
    </div>
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
  return (
    <span className="font-bold text-amber-600 dark:text-amber-400">
      {children}
    </span>
  )
}

function Red({ children }: { children: ReactNode }) {
  return <span className="text-red-600 dark:text-red-400">{children}</span>
}
