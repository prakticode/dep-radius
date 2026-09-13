import type { ReactNode } from "react"
import type { MDXComponents } from "mdx/types"
import defaultMdxComponents from "fumadocs-ui/mdx"
import { asMarkdown, md } from "fumadocs-core/server"
import * as TabsComponents from "fumadocs-ui/components/tabs"
import { Step as UiStep, Steps as UiSteps } from "fumadocs-ui/components/steps"
import {
  Accordion as UiAccordion,
  Accordions as UiAccordions,
} from "fumadocs-ui/components/accordion"

// Each wrapper gives its component a Markdown form, so /llms.txt, /llms-full.txt and every .md page
// read as plain Markdown for agents instead of JSX tags.

const UiCallout = defaultMdxComponents.Callout
const UiCard = defaultMdxComponents.Card
const UiCards = defaultMdxComponents.Cards
const UiCodeBlockTabs = defaultMdxComponents.CodeBlockTabs
const UiCodeBlockTabsList = defaultMdxComponents.CodeBlockTabsList
const UiCodeBlockTabsTrigger = defaultMdxComponents.CodeBlockTabsTrigger
const UiCodeBlockTab = defaultMdxComponents.CodeBlockTab

// the ```npm blocks: one labelled code block per package manager, the tab bar dropped
function CodeBlockTabs(props: React.ComponentProps<typeof UiCodeBlockTabs>) {
  if (asMarkdown()) return md`${props.children}`
  return <UiCodeBlockTabs {...props} />
}

function CodeBlockTabsList(
  props: React.ComponentProps<typeof UiCodeBlockTabsList>
) {
  if (asMarkdown()) return ""
  return <UiCodeBlockTabsList {...props} />
}

function CodeBlockTabsTrigger(
  props: React.ComponentProps<typeof UiCodeBlockTabsTrigger>
) {
  if (asMarkdown()) return ""
  return <UiCodeBlockTabsTrigger {...props} />
}

function CodeBlockTab(props: React.ComponentProps<typeof UiCodeBlockTab>) {
  if (asMarkdown()) return md`${String(props.value)}:\n\n${props.children}\n\n`
  return <UiCodeBlockTab {...props} />
}

function Steps({ children }: { children: ReactNode }) {
  if (asMarkdown()) return md`${children}`
  return <UiSteps>{children}</UiSteps>
}

function Step({ children }: { children: ReactNode }) {
  if (asMarkdown()) return md`${children}`
  return <UiStep>{children}</UiStep>
}

function Accordions(props: React.ComponentProps<typeof UiAccordions>) {
  if (asMarkdown()) return md`${props.children}`
  return <UiAccordions {...props} />
}

function Accordion(props: React.ComponentProps<typeof UiAccordion>) {
  if (asMarkdown()) return md`### ${props.title}\n\n${props.children}\n\n`
  return <UiAccordion {...props} />
}

function Callout(props: React.ComponentProps<typeof UiCallout>) {
  if (asMarkdown())
    return md.linePrefix(
      "> "
    )`${props.title ? md`**${props.title}**\n\n` : ""}${props.children}`
  return <UiCallout {...props} />
}

function Cards(props: React.ComponentProps<typeof UiCards>) {
  if (asMarkdown()) return md`${props.children}\n`
  return <UiCards {...props} />
}

function Card(props: React.ComponentProps<typeof UiCard>) {
  if (asMarkdown()) {
    const title = props.href ? md`[${props.title}](${props.href})` : props.title
    return props.children
      ? md`- ${title}: ${props.children}\n`
      : md`- ${title}\n`
  }
  return <UiCard {...props} />
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...TabsComponents,
    Accordion,
    Accordions,
    Callout,
    Card,
    Cards,
    CodeBlockTab,
    CodeBlockTabs,
    CodeBlockTabsList,
    CodeBlockTabsTrigger,
    Step,
    Steps,
    ...components,
  } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
