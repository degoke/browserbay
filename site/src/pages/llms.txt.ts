import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { sidebar } from '../sidebar.mjs'
import { EYEBROW } from '../site.mjs'

// llms.txt (https://llmstxt.org): a plain list of the docs for AI crawlers and assistants, in reading order, built from
// the same sidebar and page descriptions as the site, so it cannot drift.
export const GET: APIRoute = async ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const link = (slug: string) => new URL(`${base}/${slug}/`, site).href
  const pages = new Map((await getCollection('docs')).map((entry) => [entry.id, entry]))

  const lines = [
    '# browserbay',
    '',
    `> ${EYEBROW}. You ask a box for a browser and get back a DevTools address and a token; what drives it is up to you.`,
    '',
    'browserbay is a relay plus browser nodes that lend out isolated Chromium browsers (one BrowserContext per slot) over the Chrome DevTools Protocol. It works with Playwright, Puppeteer or any CDP client, has clients for Node, Python and Go, runs in Docker or on Kubernetes, and supports live view: a person can watch and steer a browser while a service is away. It is MIT licensed.',
    ''
  ]
  for (const section of sidebar) {
    lines.push(`## ${section.label}`, '')
    for (const item of section.items) {
      const page = pages.get(item.slug)
      if (!page) continue
      const description = page.data.description ? `: ${page.data.description}` : ''
      lines.push(`- [${page.data.title}](${link(item.slug)})${description}`)
    }
    lines.push('')
  }
  lines.push(
    '## Optional',
    '',
    '- [Source code](https://github.com/degoke/browserbay): the repository, issues and releases',
    '- [Changelog](https://github.com/degoke/browserbay/blob/main/CHANGELOG.md): what changed in each release',
    ''
  )
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
