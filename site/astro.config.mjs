import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { unified } from '@astrojs/markdown-remark'
import remarkBase from './src/remark-base.mjs'
import { sidebar } from './src/sidebar.mjs'
import { EYEBROW, SITE_URL, TAGLINE } from './src/site.mjs'

// The site's address lives in src/site.mjs. Set SITE_URL (and SITE_BASE, for a subpath such as a GitHub Pages project
// site) to build for somewhere else.
const site = SITE_URL
const baseSegment = (process.env.SITE_BASE ?? '/').replace(/^\/+|\/+$/g, '')
const base = baseSegment ? `/${baseSegment}` : '/'
const prefix = baseSegment ? `/${baseSegment}/` : '/'

export default defineConfig({
  site,
  base,
  markdown: { processor: unified({ remarkPlugins: [[remarkBase, { base }]] }) },
  integrations: [
    starlight({
      title: 'browserbay',
      description: `${EYEBROW}. ${TAGLINE.join(' ')}`,
      logo: { light: './src/assets/mark.svg', dark: './src/assets/mark-reverse.svg', alt: '' },
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: `${prefix}favicon.ico`, sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${prefix}apple-touch-icon.png` } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#EEF1F8', media: '(prefers-color-scheme: light)' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0C0F22', media: '(prefers-color-scheme: dark)' } }
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/degoke/browserbay' }],
      customCss: [
        '@fontsource-variable/bricolage-grotesque',
        '@fontsource-variable/instrument-sans',
        '@fontsource/dm-mono/400.css',
        '@fontsource/dm-mono/500.css',
        './src/styles/docs.css'
      ],
      editLink: { baseUrl: 'https://github.com/degoke/browserbay/edit/main/site/' },
      routeMiddleware: './src/routeData.ts',
      sidebar
    })
  ]
})
