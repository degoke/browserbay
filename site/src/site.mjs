// The address and the words the site, its share images and the brand files all use. Change them here, once.

/** Where the site is served. Canonical URLs, the sitemap, robots.txt, llms.txt and the share images start from it. */
export const SITE_URL = process.env.SITE_URL || 'https://browserbay.3adelabs.com'

/** The small label above the headline, and the opening of the site description. */
export const EYEBROW = 'Self-hosted browsers for AI agents and automation'

/** The headline, one beat per line. */
export const TAGLINE = ['Run browsers anywhere.', 'Watch them live.', 'Drive them with any agent.']

/** The landing page's meta description (also its social description and structured data). */
export const DESCRIPTION =
  'Run browsers anywhere, watch them live, and drive them with any agent. Self-hosted Chromium for AI agents and automation, with live view for your own app.'

/** The line under the headline on the landing page's share image. */
export const CARD_DESCRIPTION = 'Self-hosted Chromium for AI agents and automation, with live view for your own app.'
