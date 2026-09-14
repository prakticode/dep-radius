import Link from "next/link"
import type { ReactNode } from "react"
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc"

import { githubUrl } from "@/lib/shared"
import { DemoVideo } from "@/components/home/demo-video"
import { AgentSession } from "@/components/home/agent-session"

const agentsSnippet = `## Dependency upgrades

After you change a dependency version,
run this before you say you're done:

    npx dep-radius --since HEAD --json

- Exit 0: nothing this project uses changed.
  Run the tests.
- Exit 1 or 2: open each file and line it
  lists. Fix what the change breaks. Run or
  add tests for those files. Run it again.
- Exit 3: radius failed. Say so.

Tests are still required.`

const actionSnippet = `on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  brief:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: prakticode/dep-radius@v0`

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pt-16 pb-20 lg:grid-cols-2 lg:pt-24">
        <div className="flex flex-col items-start gap-6">
          <span className="rounded-full border bg-fd-card px-3 py-1 text-xs font-medium text-fd-muted-foreground">
            For AI coding agents
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Your agent upgraded a dependency.{" "}
            <span className="text-fd-primary">What changed for your code?</span>
          </h1>
          <p className="max-w-xl text-lg text-fd-muted-foreground">
            Release notes describe changes like a new default or a stricter
            check. The code still compiles and the tests still pass, so nobody
            notices. radius reads the notes, finds where your code is affected,
            and gives your agent the files and lines to check.
          </p>
          <div className="w-full max-w-md">
            <ServerCodeBlock
              lang="sh"
              code="npx dep-radius --since HEAD --json"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs/agents"
              className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Add it to your agent
            </Link>
            <Link
              href="/docs/quickstart"
              className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
            >
              Run it yourself
            </Link>
          </div>
          <p className="text-sm text-fd-muted-foreground">
            No AI inside. Your code stays on your machine. Free and open source.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <AgentSession />
          <p className="text-xs text-fd-muted-foreground">
            An example. The note, the line and the verdict are real radius
            output for zod 4.4.3 → 4.5.0.
          </p>
        </div>
      </section>

      <section className="border-y bg-fd-card/50">
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <h2 className="mb-8 text-2xl font-semibold tracking-tight">
            Why the usual checks miss it
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            <Card title="It compiles">
              The compiler catches a removed function. It doesn&apos;t catch a
              function that works differently.
            </Card>
            <Card title="The tests pass">
              zod 4.5 counts an emoji as one character in <code>.min()</code>.
              If no test uses emoji, nothing fails.
            </Card>
            <Card title="The notes said it">
              The change was in the release notes. Nobody checked them against
              your code.
            </Card>
          </div>
        </div>
      </section>

      <Feature
        eyebrow="How it works"
        title="Files and lines, not a summary"
        body={
          <>
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              <li>Your agent upgrades a dependency.</li>
              <li>
                It runs <code>npx dep-radius --since HEAD --json</code>.
              </li>
              <li>
                radius reads the release notes and the types of both versions,
                and finds every place your code uses the package.
              </li>
              <li>
                It returns the notes that affect your code, with the files and
                lines.
              </li>
              <li>
                Your agent opens those lines, fixes them, and runs the tests.
              </li>
            </ol>
            <p>Same project, same versions: same answer, every time.</p>
            <Link href="/docs/agents" className="font-medium text-fd-primary">
              The agent guide →
            </Link>
          </>
        }
        code={<ServerCodeBlock lang="md" code={agentsSnippet} />}
      />

      <section className="mx-auto w-full max-w-4xl px-6 py-12">
        <div className="rounded-xl border bg-fd-card p-8">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            How I use it
          </h2>
          <div className="flex flex-col gap-3 text-fd-muted-foreground">
            <p>
              I don&apos;t run radius myself. Claude Code does. The instructions
              above are in my projects&apos; CLAUDE.md.
            </p>
            <p>
              When Claude Code upgrades a dependency, it runs radius, opens the
              lines, and runs the tests for those files. Then it tells me the
              upgrade is done. I read its summary, not the changelogs.
            </p>
          </div>
        </div>
      </section>

      <section className="border-y bg-fd-card/50">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 py-16 sm:grid-cols-3">
          <Verdict
            word="quiet"
            tone="text-emerald-600 dark:text-emerald-400"
            code="exit 0"
          >
            Nothing your code uses changed. Merge. This is rare: about one
            update in ten.
          </Verdict>
          <Verdict
            word="review"
            tone="text-amber-600 dark:text-amber-400"
            code="exit 1"
          >
            Some notes may affect your code. Here are the lines, and the notes
            radius couldn&apos;t place.
          </Verdict>
          <Verdict
            word="blocked"
            tone="text-red-600 dark:text-red-400"
            code="exit 2"
          >
            Something your code calls was removed. Here is every place that
            calls it.
          </Verdict>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <h2 className="mb-2 text-2xl font-semibold tracking-tight">
          Does it work?
        </h2>
        <p className="mb-8 max-w-3xl text-fd-muted-foreground">
          radius is tested on 51 real release notes that changed behaviour. For
          each one, the lines it should find were written down before it ran.
        </p>
        <div className="grid gap-6 md:grid-cols-3">
          <Stat value="0 of 51" label="called safe by mistake">
            When radius can&apos;t link a change to your code, it says review,
            never quiet.
          </Stat>
          <Stat value="25 of 51" label="found at the exact line">
            For the others, radius still says review. It just can&apos;t point
            at the line.
          </Stat>
          <Stat value="1 in 10" label="real upgrades called quiet">
            Out of 451 upgrades in three open source projects. Quiet is rare, so
            you can trust it.
          </Stat>
        </div>
        <Link
          href="/docs/benchmark"
          className="mt-6 inline-block font-medium text-fd-primary"
        >
          Every case, including the misses →
        </Link>
      </section>

      <section className="border-y bg-fd-card/50">
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <h2 className="mb-8 text-2xl font-semibold tracking-tight">
            Questions
          </h2>
          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
            <Question q="Why not let the agent read the changelog?">
              It can, but it guesses which files a note affects, and may miss
              some. It can give a different answer next time. radius finds every
              place your code uses the package and gives the same answer every
              time.
            </Question>
            <Question q="Is it an AI?">
              No. It reads your code with the TypeScript parser, compares type
              files, and reads release notes. No model, no guessing.
            </Question>
            <Question q="Does my code leave my machine?">
              No. radius only downloads information about packages: versions,
              package files, release notes. It never installs or runs them.
            </Question>
            <Question q="What can it miss?">
              A change nobody wrote in the notes. That&apos;s why your agent
              still runs the tests.
            </Question>
            <Question q="Why is almost everything review?">
              Most releases contain a fix written in plain words. radius
              can&apos;t prove it doesn&apos;t affect you, so it shows it to
              you. You read a few lines, not the whole changelog.
            </Question>
            <Question q="What do I need to set it up?">
              Nothing. <code>npx dep-radius</code>. No account, no config. Works
              with npm, pnpm, Yarn, Bun and monorepos. MIT licensed.
            </Question>
          </div>
          <Link
            href="/docs/faq"
            className="mt-8 inline-block font-medium text-fd-primary"
          >
            More questions →
          </Link>
        </div>
      </section>

      <Feature
        eyebrow="On pull requests"
        title="The same answer, on the pull request"
        body={
          <>
            <p>
              Renovate or Dependabot opens a pull request. The GitHub Action
              adds a comment with the verdict and the lines. It fails the check
              if something your code calls was removed.
            </p>
            <p>
              radius doesn&apos;t replace these bots. They tell you an update
              exists. radius tells you what it changes for your code.
            </p>
            <Link
              href="/docs/github-action"
              className="font-medium text-fd-primary"
            >
              Set up the Action →
            </Link>
          </>
        }
        code={<ServerCodeBlock lang="yaml" code={actionSnippet} />}
      />

      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <h2 className="mb-2 text-2xl font-semibold tracking-tight">
          A real run, on vercel/commerce
        </h2>
        <p className="mb-8 max-w-2xl text-fd-muted-foreground">
          Four of its dependencies, not edited: a changed function with the five
          lines that use it, a release note with the one line it affects, a
          quiet update, and a package radius can&apos;t see into.
        </p>
        <DemoVideo />
        <p className="mt-4 text-sm text-fd-muted-foreground">
          <code>
            npx dep-radius @types/react sonner @headlessui/react geist
          </code>{" "}
          at commit <code>1df2cf6</code>, recorded with an earlier version of
          radius.
        </p>
      </section>

      <section className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-6 py-20 text-center">
          <h2 className="text-3xl font-semibold tracking-tight">
            Try it after your next upgrade.
          </h2>
          <div className="w-full max-w-md">
            <ServerCodeBlock
              lang="sh"
              code="npx dep-radius --since HEAD --json"
            />
          </div>
          <div className="flex gap-4 text-sm">
            <Link href="/docs/agents" className="font-medium text-fd-primary">
              Add it to your agent
            </Link>
            <a href={githubUrl} className="font-medium text-fd-primary">
              Source on GitHub
            </a>
          </div>
        </div>
      </section>
    </main>
  )
}

function Verdict({
  word,
  tone,
  code,
  children,
}: {
  word: string
  tone: string
  code: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <span className={`text-2xl font-bold ${tone}`}>{word}</span>
        <span className="font-mono text-xs text-fd-muted-foreground">
          {code}
        </span>
      </div>
      <p className="text-fd-muted-foreground">{children}</p>
    </div>
  )
}

function Feature({
  eyebrow,
  title,
  body,
  code,
  reverse = false,
}: {
  eyebrow: string
  title: string
  body: ReactNode
  code: ReactNode
  reverse?: boolean
}) {
  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-6 py-16 lg:grid-cols-2">
      <div
        className={`flex flex-col gap-4 text-fd-muted-foreground ${reverse ? "lg:order-2" : ""}`}
      >
        <span className="text-sm font-medium text-fd-primary">{eyebrow}</span>
        <h2 className="text-3xl font-semibold tracking-tight text-fd-foreground">
          {title}
        </h2>
        {body}
      </div>
      <div className="min-w-0">{code}</div>
    </section>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-fd-card p-6">
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm text-fd-muted-foreground">{children}</p>
    </div>
  )
}

function Stat({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border bg-fd-card p-6">
      <div className="text-3xl font-bold tracking-tight">{value}</div>
      <div className="mb-3 text-sm font-medium">{label}</div>
      <p className="text-sm text-fd-muted-foreground">{children}</p>
    </div>
  )
}

function Question({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold">{q}</h3>
      <p className="text-fd-muted-foreground">{children}</p>
    </div>
  )
}
