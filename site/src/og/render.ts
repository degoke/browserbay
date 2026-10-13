// Draws the social share images (1200 x 630, the size Facebook, LinkedIn, X and Slack all show) at build time. satori
// lays the card out like a web page and turns it into SVG with the text already outlined; resvg turns that into a PNG.
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
// `?inline` makes Vite put the font file into the build as a data URI, so there is no path to find at run time: the
// build works from any working directory and any output directory. satori reads TTF, OTF and WOFF (not WOFF2), which
// the @fontsource packages ship alongside their WOFF2 files.
import bricolage800 from '@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-800-normal.woff?inline'
import instrument400 from '@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff?inline'
import dmMono500 from '@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff?inline'

export interface OgCard {
  /** A short label above the title, e.g. "Docs · Guides". */
  kicker: string
  /** One line of text, or several lines (the landing page's three beats), each on its own row. */
  title: string | string[]
  description?: string
  /** The site's host (for example browserbay.3adelabs.com), printed at the bottom of the card. */
  host: string
  /** Colour the title's last character with the accent (the landing page's full stop). */
  accentLastCharacter?: boolean
}

const WIDTH = 1200
const HEIGHT = 630
const INK = '#E9ECFA'
const MUTED = '#9AA3D1'
const ACCENT = '#5B8CFF'
const GROUND = '#0C0F22'

type Font = { name: string; data: Buffer; weight: 400 | 500 | 700 | 800; style: 'normal' }
let fonts: Font[] | undefined

const fromDataUri = (uri: string) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')

function loadFonts(): Font[] {
  if (fonts) return fonts
  fonts = [
    { name: 'Bricolage Grotesque', data: fromDataUri(bricolage800), weight: 800, style: 'normal' },
    { name: 'Instrument Sans', data: fromDataUri(instrument400), weight: 400, style: 'normal' },
    { name: 'DM Mono', data: fromDataUri(dmMono500), weight: 500, style: 'normal' }
  ]
  return fonts
}

// satori takes plain objects shaped like React elements, so there is no React in the build.
type Node = { type: string; props: Record<string, unknown> }
const h = (type: string, props: Record<string, unknown> = {}, children?: unknown): Node => ({
  type,
  props: { ...props, ...(children === undefined ? {} : { children }) }
})

/** The brand mark: four slots, one of them in use. The same drawing as brand/mark-reverse.svg. */
function mark(size: number, opacity = 1): Node {
  const outline = { fill: 'none', stroke: INK, strokeWidth: 4 }
  return h('svg', { width: size, height: size, viewBox: '0 0 64 64', style: { opacity } }, [
    h('rect', { x: 8, y: 8, width: 20, height: 20, rx: 5.5, ...outline }),
    h('rect', { x: 36, y: 8, width: 20, height: 20, rx: 5.5, ...outline }),
    h('rect', { x: 8, y: 36, width: 20, height: 20, rx: 5.5, ...outline }),
    h('rect', { x: 34, y: 34, width: 24, height: 24, rx: 7, fill: ACCENT }),
    h('circle', { cx: 40, cy: 41, r: 1.9, fill: '#fff' }),
    h('rect', { x: 44, y: 39.5, width: 9, height: 3, rx: 1.5, fill: '#fff' })
  ])
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

// A long title gets a smaller size so it stays on two or three lines.
const titleSize = (title: string) =>
  title.length <= 12 ? 124 : title.length <= 18 ? 102 : title.length <= 30 ? 86 : title.length <= 46 ? 70 : 58

function card({ kicker, title, description, accentLastCharacter, host }: OgCard): Node {
  // A list of lines is laid out as rows, so the accent full stop stays attached to the end of the last one.
  const lines = Array.isArray(title) ? title : [title]
  const size = Array.isArray(title) ? 72 : titleSize(title)
  const line = (text: string, last: boolean): Node =>
    accentLastCharacter && last
      ? h('div', { style: { display: 'flex' } }, [
          h('span', {}, text.slice(0, -1)),
          h('span', { style: { color: ACCENT } }, text.slice(-1))
        ])
      : h('div', { style: { display: 'flex' } }, text)
  const titleNode: Node | string =
    Array.isArray(title) || accentLastCharacter
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          lines.map((text, i) => line(text, i === lines.length - 1))
        )
      : title

  return h(
    'div',
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background: GROUND,
        color: INK,
        fontFamily: 'Instrument Sans',
        position: 'relative'
      }
    },
    [
      // a faint, oversized mark in the corner, like the repository's social card
      h('div', { style: { position: 'absolute', right: -40, bottom: -40, display: 'flex' } }, mark(380, 0.13)),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } }, [
          mark(52),
          h(
            'div',
            { style: { fontFamily: 'Bricolage Grotesque', fontWeight: 800, fontSize: 34, letterSpacing: -1 } },
            'browserbay'
          )
        ]),
        h(
          'div',
          {
            style: {
              fontFamily: 'DM Mono',
              fontWeight: 500,
              fontSize: 22,
              color: MUTED,
              textTransform: 'uppercase',
              letterSpacing: 2
            }
          },
          kicker
        )
      ]),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 26, maxWidth: 1056 } }, [
        h(
          'div',
          {
            style: {
              fontFamily: 'Bricolage Grotesque',
              fontWeight: 800,
              fontSize: size,
              lineHeight: 1.02,
              letterSpacing: -3,
              display: 'flex'
            }
          },
          titleNode
        ),
        ...(description
          ? [
              h(
                'div',
                { style: { fontSize: 33, lineHeight: 1.35, color: MUTED, display: 'flex', maxWidth: 780 } },
                clip(description, 150)
              )
            ]
          : [])
      ]),
      h('div', { style: { fontFamily: 'DM Mono', fontWeight: 500, fontSize: 24, color: MUTED, display: 'flex' } }, host)
    ]
  )
}

/** The card as a PNG. */
export async function renderOgImage(options: OgCard): Promise<Buffer> {
  const svg = await satori(card(options) as never, { width: WIDTH, height: HEIGHT, fonts: loadFonts() })
  return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
}
