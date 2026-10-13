// Regenerates the raster brand files from the SVGs, and copies the files the website needs into site/.
//
//   node brand/render.mjs
//
// The SVG files in this folder are the source of truth: edit those, then run this. Needs Playwright's Chromium
// (`pnpm exec playwright install chromium`, or point CHROMIUM_EXECUTABLE at any Chromium) and a network connection,
// because the wordmark is set in Bricolage Grotesque, which is loaded from Google Fonts while rendering.
import { chromium } from 'playwright'
import fs from 'node:fs'
import { TAGLINE } from '../site/src/site.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRAND = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.join(BRAND, '..', 'site')

const svg = (file) => fs.readFileSync(path.join(BRAND, file), 'utf8')
const FONT = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&display=swap">`
const wordmark = (color, size) =>
  `font-family:'Bricolage Grotesque',sans-serif;font-weight:800;letter-spacing:-0.03em;font-size:${size}px;line-height:1;color:${color}`

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined })

async function shot(name, html, width, height, { transparent = true, scale = 2 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  const page = await context.newPage()
  await page.setContent(
    `<!doctype html><meta charset=utf-8>${FONT}<style>html,body{margin:0;padding:0}svg{display:block}</style>${html}`
  )
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  await page.screenshot({
    path: path.join(BRAND, name),
    omitBackground: transparent,
    clip: { x: 0, y: 0, width, height }
  })
  await context.close()
  console.log('wrote', name)
}

const lockup = (mark, color, height = 120) =>
  `<div style="display:inline-flex;align-items:center;gap:${height * 0.22}px"><div style="width:${height}px;height:${height}px">${mark}</div><span style="${wordmark(color, height * 0.78)}">browserbay</span></div>`

const markLight = svg('mark.svg')
const markDark = svg('mark-reverse.svg')

// Lockups, transparent.
for (const [name, mark, color] of [
  ['lockup.png', markLight, '#1B1F3B'],
  ['lockup-reverse.png', markDark, '#E9ECFA']
]) {
  await shot(name, `<div style="padding:40px;width:max-content">${lockup(mark, color)}</div>`, 760, 200)
}

// App icons, on the dark ground.
await shot(
  'icon-512.png',
  `<div style="width:512px;height:512px;background:#0C0F22;display:grid;place-items:center"><div style="width:300px;height:300px">${markDark}</div></div>`,
  512,
  512,
  { transparent: false, scale: 1 }
)
await shot(
  'apple-touch-icon.png',
  `<div style="width:180px;height:180px;background:#0C0F22;display:grid;place-items:center"><div style="width:110px;height:110px">${markDark}</div></div>`,
  180,
  180,
  { transparent: false, scale: 1 }
)

// Favicons, from favicon.svg.
const favicon = svg('favicon.svg')
const faviconSizes = [16, 32, 48]
const faviconFiles = faviconSizes.map((size) => path.join(BRAND, `favicon-${size}.png`))
for (const size of faviconSizes) {
  await shot(
    `favicon-${size}.png`,
    `<div style="width:${size}px;height:${size}px;background:#fff">${favicon.replace('<svg', `<svg width="${size}" height="${size}"`)}</div>`,
    size,
    size,
    { transparent: false, scale: 1 }
  )
}

// Social card, 1280 x 640.
await shot(
  'social-card.png',
  `<div style="width:1280px;height:640px;background:#0C0F22;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box;gap:36px">
     ${lockup(markDark, '#E9ECFA', 132)}
     <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:500;font-size:38px;line-height:1.25;color:#9AA3D1;max-width:760px">${TAGLINE.join(' ')}</div>
     <div style="position:absolute;right:-30px;bottom:-30px;width:300px;height:300px;opacity:.14">${markDark}</div>
   </div>`,
  1280,
  640,
  { transparent: false, scale: 1 }
)

await browser.close()

// favicon.ico: three PNGs in one ICO container.
const pngs = faviconFiles.map((file) => fs.readFileSync(file))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(faviconSizes.length, 4)
let offset = 6 + 16 * faviconSizes.length
const directory = Buffer.concat(
  faviconSizes.map((size, i) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size, 0)
    entry.writeUInt8(size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(pngs[i].length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += pngs[i].length
    return entry
  })
)
fs.writeFileSync(path.join(BRAND, 'favicon.ico'), Buffer.concat([header, directory, ...pngs]))
for (const file of faviconFiles) fs.rmSync(file)
console.log('wrote favicon.ico')

// The website uses copies of these files. Refresh them so the two never drift.
const copies = [
  ['mark.svg', 'src/assets'],
  ['mark-reverse.svg', 'src/assets'],
  ['favicon.svg', 'public'],
  ['favicon.ico', 'public'],
  ['apple-touch-icon.png', 'public'],
  ['social-card.png', 'public']
]
for (const [file, dir] of copies) {
  fs.mkdirSync(path.join(SITE, dir), { recursive: true })
  fs.copyFileSync(path.join(BRAND, file), path.join(SITE, dir, file))
}
console.log(`copied ${copies.length} files into site/`)
