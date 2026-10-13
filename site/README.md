# browserbay website

The landing page and the docs, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

```sh
cd site
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # static output in site/dist
pnpm preview    # serve the build
```

Run the build from `site/`, or from the repository root as `pnpm --dir site build`. `astro build --root site` from another directory does not work: Astro puts its temporary files under the current directory, where it cannot find the site's packages. The output directory can be anywhere (`astro build --outDir ...`).

The site is a separate package from the browserbay box: it has its own `package.json` and lockfile, and nothing in `src/` imports from it.

## Where things are

| Path                     | What                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/index.astro`  | The landing page. Custom Astro, with its own styles.                                                                                                                    |
| `src/content/docs/docs/` | The docs, as MDX. The folder name `docs/docs` makes the URLs `/docs/...`.                                                                                               |
| `src/site.mjs`           | The site address, headline and descriptions, used by the config, the landing page, the share images and `llms.txt` (and by `brand/render.mjs`). Change them here, once. |
| `astro.config.mjs`       | Site settings and the docs sidebar. Add a page to the sidebar here when you create one.                                                                                 |
| `src/styles/docs.css`    | The brand theme for the docs: colours, fonts.                                                                                                                           |
| `src/assets/`, `public/` | Copies of the mark, favicons and social card from `../brand`. Refresh them with `node brand/render.mjs`.                                                                |
| `src/remark-base.mjs`    | Prefixes root-relative links, images and `href`/`src` attributes in the docs with the site's base path.                                                                 |

## Share images

Every page has its own social share image (1200 x 630, the size Facebook, LinkedIn, X and Slack show), drawn at build time from the page's title and description, so a new docs page gets one without anyone designing it.

- `src/og/render.ts` draws the card (satori for the layout, resvg for the PNG, in the brand fonts).
- `src/pages/og/[...slug].png.ts` makes one image per page: `/og/home.png` for the landing page and `/og/<docs slug>.png` for each docs page.
- `src/routeData.ts` puts each docs page's image in its `og:image` tag. The landing page sets its own in `src/pages/index.astro`.

To change how the cards look, edit `render.ts` and run `pnpm build`. `public/social-card.png` (1280 x 640) is a different file: it is the repository's GitHub social preview, made by `brand/render.mjs`.

## Deploying

It is a static site, so any static host works. Two environment variables set where it lives:

| Variable    | Default                           | Meaning                                                                                                                               |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`  | `https://browserbay.3adelabs.com` | The full address the site is served at. Canonical URLs, the sitemap, `robots.txt`, `llms.txt` and the social image all start from it. |
| `SITE_BASE` | `/`                               | The path the site is served under. For GitHub Pages project sites use `/browserbay`.                                                  |

```sh
SITE_URL=https://degoke.github.io SITE_BASE=/browserbay pnpm build
```

The default is the real address, so a normal build is ready to deploy. Set it only to build for somewhere else (a preview, a fork). `SITE_BASE` may be written with or without slashes (`/browserbay`, `browserbay/`).

## Keeping the docs honest

The docs describe what the box does. When you change behaviour in `src/` (a setting, an endpoint, a limit), update the matching page here and in the root `README.md`. The live view guide's code was run against a real box; if you change the snippet, run it again.
