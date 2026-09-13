import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"

import { Logo } from "@/components/logo"

import { appName, githubUrl, npmUrl } from "./shared"

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Logo className="size-5 text-fd-primary" />
          <span className="font-semibold">{appName}</span>
        </>
      ),
    },
    githubUrl,
    links: [{ text: "npm", url: npmUrl, external: true, secondary: true }],
  }
}

// the home navbar leads into the docs; inside the docs, the sidebar already lists these pages
export function homeLinks(): NonNullable<BaseLayoutProps["links"]> {
  return [
    { text: "Docs", url: "/docs", active: "nested-url" },
    { text: "For AI agents", url: "/docs/agents", active: "url" },
    { text: "GitHub Action", url: "/docs/github-action", active: "url" },
    ...(baseOptions().links ?? []),
  ]
}
