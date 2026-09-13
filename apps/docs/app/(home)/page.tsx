import Link from "next/link"
import type { ReactNode } from "react"
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc"

import { githubUrl } from "@/lib/shared"
import { Terminal } from "@/components/home/terminal"

const agentsSnippet = `## Dependency updates

After changing a dependency version, run:

    npx dep-radius --since HEAD --json

- 0, quiet: nothing used changed. Run the tests.
- 1, review: open each site in types.touched
  and notes.matched, adapt, run radius again.
- 2, blocked: an export in use was removed.
  Fix those sites first.`

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
            For AI agents, and the humans who review their pull requests
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Know which dependency updates{" "}
            <span className="text-fd-primary">touch your code.</span>
          </h1>
          <p className="max-w-xl text-lg text-fd-muted-foreground">
            radius compares each update&apos;s types and release notes with the
            code that actually uses the package. You get one word per update,
            quiet, review or blocked, and the exact lines behind it.
          </p>
          <div className="w-full max-w-sm">
            <ServerCodeBlock lang="sh" code="npx dep-radius" />
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs/quickstart"
              className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
            <Link
              href="/docs/agents"
              className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
            >
              Use it from an agent
            </Link>
          </div>
          <p className="text-sm text-fd-muted-foreground">
            No account. No config file. Free and open source.
          </p>
        </div>
        <Terminal />
      </section>

      <section className="border-y bg-fd-card/50">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 py-16 sm:grid-cols-3">
          <Verdict
            word="quiet"
            tone="text-emerald-600 dark:text-emerald-400"
            code="exit 0"
          >
            Nothing you use changed, and no release note mentions it. Merge
            without reading.
          </Verdict>
          <Verdict
            word="review"
            tone="text-amber-600 dark:text-amber-400"
            code="exit 1"
          >
            Here are the lines concerned, or what radius couldn&apos;t see. Two
            minutes, not forty changelogs.
          </Verdict>
          <Verdict
            word="blocked"
            tone="text-red-600 dark:text-red-400"
            code="exit 2"
          >
            An export you call was removed. You&apos;ll know before the build
            does.
          </Verdict>
        </div>
      </section>

      <Feature
        eyebrow="Agents first"
        title="Two relevant lines instead of forty changelogs"
        body={
          <>
            <p>
              Agents upgrade dependencies all day. Reading every release note
              burns tokens, skipping them breaks things. radius gives your agent
              a stable JSON brief, honest exit codes, and{" "}
              <code>--since HEAD</code> for &quot;I just bumped things, what did
              I break?&quot;.
            </p>
            <p>Paste the instructions into AGENTS.md and you&apos;re done.</p>
            <Link href="/docs/agents" className="font-medium text-fd-primary">
              The agent guide →
            </Link>
          </>
        }
        code={<ServerCodeBlock lang="md" code={agentsSnippet} />}
      />

      <Feature
        reverse
        eyebrow="On every pull request"
        title="The brief, right where the update is"
        body={
          <>
            <p>
              Renovate or Dependabot opens the pull request, the GitHub Action
              comments with the verdict and the lines concerned, and edits that
              comment on every push. No install step: radius reads the lockfile.
            </p>
            <p>
              Quiet and green? Auto-merge it. Blocked? The check fails before
              anyone merges.
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

      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <h2 className="mb-2 text-2xl font-semibold tracking-tight">
          Two nets, never merged into one reassuring number
        </h2>
        <p className="mb-8 max-w-2xl text-fd-muted-foreground">
          Each update is checked twice, independently. Anything radius
          can&apos;t see pushes towards review, never towards quiet.
        </p>
        <div className="grid gap-6 md:grid-cols-3">
          <Card title="The type surface">
            Both versions&apos; declarations, compared export by export with its
            own TypeScript compiler, matched against the names your code uses,
            through re-export files and values built elsewhere.
          </Card>
          <Card title="The release notes">
            Every version between yours and the target, from the package, its
            GitHub releases or its changelog. Only the entries that name
            something you use are kept.
          </Card>
          <Card title="What it can't see">
            Packages run from scripts, named in config files, passed around
            whole. Listed plainly, so nothing is quiet by accident.
          </Card>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-6 py-20 text-center">
          <h2 className="text-3xl font-semibold tracking-tight">
            Try it on your project. It takes a minute.
          </h2>
          <div className="w-full max-w-sm">
            <ServerCodeBlock lang="sh" code="npx dep-radius" />
          </div>
          <div className="flex gap-4 text-sm">
            <Link href="/docs" className="font-medium text-fd-primary">
              Read the docs
            </Link>
            <a href={githubUrl} className="font-medium text-fd-primary">
              Star it on GitHub
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
