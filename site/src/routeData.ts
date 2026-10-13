import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

// Gives every docs page its own share image (drawn by src/pages/og/[...slug].png.ts) in place of one image for all.
export const onRequest = defineRouteMiddleware((context) => {
  const { entry, head } = context.locals.starlightRoute
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  // Only the landing page and the docs pages have their own image. Anything else (the not-found page) shares the
  // landing page's, so no page points at a file that does not exist.
  const slug = entry.id === '404' ? 'home' : entry.id
  const image = new URL(`${base}/og/${slug}.png`, context.site).href
  head.push(
    { tag: 'meta', attrs: { property: 'og:image', content: image } },
    { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
    { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
    { tag: 'meta', attrs: { property: 'og:image:alt', content: `${entry.data.title}: browserbay docs` } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: image } }
  )
})
