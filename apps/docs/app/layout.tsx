import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { RootProvider } from "fumadocs-ui/provider/next"

import { appName, tagline } from "@/lib/shared"

import "./global.css"

const inter = Inter({
  subsets: ["latin"],
})

// the deployment names its own address; nothing else in the app knows the domain
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000")

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${appName}: ${tagline}`, template: `%s | ${appName}` },
  description:
    "radius tells you, and your AI agent, which changes in a dependency update land on code you actually wrote. Quiet, review or blocked, with the exact lines.",
}

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
