import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { renderOgImage, type OgCard } from '../../og/render'
import { sidebar } from '../../sidebar.mjs'
import { CARD_DESCRIPTION, TAGLINE } from '../../site.mjs'

// One share image per page, drawn at build time: /og/home.png for the landing page and /og/<docs slug>.png for each docs
// page. Add a docs page and its image appears with it, so none of them has to be drawn by hand.
const sectionOf = new Map<string, string>(
  sidebar.flatMap((section) => section.items.map((item) => [item.slug, section.label] as [string, string]))
)

export const getStaticPaths = (async () => {
  const docs = await getCollection('docs')
  const home: Omit<OgCard, 'host'> = {
    kicker: 'Self-hosted browsers',
    title: TAGLINE,
    description: CARD_DESCRIPTION,
    accentLastCharacter: true
  }
  return [
    { params: { slug: 'home' }, props: { card: home } },
    ...docs.map((entry) => ({
      params: { slug: entry.id },
      props: {
        card: {
          kicker: `Docs · ${sectionOf.get(entry.id) ?? 'browserbay'}`,
          title: entry.data.title,
          description: entry.data.description
        } satisfies Omit<OgCard, 'host'>
      }
    }))
  ]
}) satisfies GetStaticPaths

export const GET: APIRoute = async ({ props, site }) => {
  // The host printed on the card is the site's own, so a build for another address says so.
  const png = await renderOgImage({ ...(props.card as Omit<OgCard, 'host'>), host: new URL(site as URL).host })
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } })
}
