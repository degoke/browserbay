# browserbay brand

The mark is a bay of four slots with one browser checked out. That is how the product works: a bay of slots on infrastructure you run, each holding one browser.

## Files

| File                                   | Use                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `mark.svg`                             | The mark on light backgrounds.                                                                           |
| `mark-reverse.svg`                     | The mark on dark backgrounds.                                                                            |
| `mark-mono.svg`                        | One colour, black by default. Inline it to set CSS `color`; as an `<img>`, change its `color` attribute. |
| `favicon.svg`, `favicon.ico`           | Browser tab. The SVG follows the viewer's light or dark setting.                                         |
| `apple-touch-icon.png`, `icon-512.png` | App and home-screen icons, on the dark ground.                                                           |
| `lockup.png`, `lockup-reverse.png`     | Mark plus wordmark, transparent, for light and dark pages.                                               |
| `social-card.png`                      | 1280 x 640 link preview. Set it as the repo's social preview.                                            |

The lockups are PNG because the wordmark is live type. An outlined SVG lockup needs the font file converted to paths first.

The PNGs and `favicon.ico` are generated. Edit the SVGs, then run `node brand/render.mjs` (it needs Playwright's Chromium and a network connection for the font). The same command refreshes the copies the website keeps in `site/`.

## Colour

|            | Light ground | Dark ground |
| ---------- | ------------ | ----------- |
| Ink        | `#1B1F3B`    | `#E9ECFA`   |
| Accent     | `#2F6BFF`    | `#5B8CFF`   |
| Ground     | `#EEF1F8`    | `#0C0F22`   |
| Quiet text | `#566775`    | `#9AA3D1`   |

The accent goes on the one slot that is in use, and nowhere else in the mark. In UI, use it for the same idea: the thing that is occupied, active or selected.

## Type

Wordmark and headings: Bricolage Grotesque 800, lowercase, letter-spacing -0.03em. Body: any quiet grotesque.

## Rules

- Clear space around the mark is half a slot on every side.
- Below 24 px use `favicon.svg`, which has heavier strokes and no browser details.
- Keep the wordmark lowercase: `browserbay`.
- Do not recolour individual slots, rotate the mark, or fill all four slots.
