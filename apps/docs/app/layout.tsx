import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
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
    "radius tells your AI agent which changes in a dependency upgrade affect your code, with the files and lines to check. No AI inside, and your code stays on your machine.",
}

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
        {/* Vercel Web Analytics: page views and referrers, without cookies */}
        <Analytics />
      </body>
    </html>
  )
}
