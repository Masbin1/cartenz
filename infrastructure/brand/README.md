# Cartenz brand assets

The mark is **Cartensz Pyramid** — Puncak Jaya, 4,884 m, the highest ground in
Indonesia, and the mountain the product is named after. It is drawn as two
faceted faces meeting at a ridge: the lit west face in the accent red, the
shadowed east face in its darker shade, and a snow cap for the summit. The
idea it carries is the one the product is meant to hold: **there is always
higher ground, and you get there by climbing**.

## Generating

```bash
python3 infrastructure/brand/generate.py
```

Requires `fonttools` (`pip3 install --user fonttools`). Everything in
`frontend/public/brand/` is generated — do not edit those files by hand, edit
`generate.py` and re-run. `node_modules/sharp` rasterises the SVGs; it is
already present as a transitive dependency, so no system Cairo or ImageMagick
is needed.

## What is generated

| File | Use |
| --- | --- |
| `mark.svg` | The pyramid alone, transparent. Anywhere the name is already present. |
| `wordmark.svg` | "Cartenz / by LinkedERP", outlined, transparent. |
| `lockup-horizontal.svg` | Mark beside the wordmark — the default signature. |
| `icon-16 … icon-512.png` | Square mark on the surface colour, for favicons and the PWA. |
| `lockup-on-dark.png` | Raster lockup on `#0d1117`. Email, slides, social. |
| `lockup-on-raised.png` | Raster lockup on `#151b23`. |
| `favicon.ico` | 16/32/48 in one file, for the browser tab. |
| `manifest.webmanifest` | Web app manifest, for the install prompt. |

Wired into the app through `frontend/app/layout.tsx` (metadata) and
`frontend/components/ui/cartenz-mark.tsx` (the inline mark).

## Palette

Taken from `frontend/tailwind.config.ts` so the brand cannot drift from the
interface it lives in. If one changes, change the other.

| Token | Hex | Role |
| --- | --- | --- |
| `ACCENT` | `#c8102e` | The lit west face. Also the theme colour. |
| `ACCENT_DARK` | `#8f0b20` | The shadowed east face. |
| `CONTENT` | `#e6edf3` | The snow cap; one-line wordmark on dark. |
| `CONTENT_MUTED` | `#9aa7b4` | The "by LinkedERP" byline. |
| `SURFACE` | `#0d1117` | Icon background. |
| `SURFACE_RAISED` | `#151b23` | Alternative icon background. |

## Rules

- **The snow cap is light.** On a light background it disappears. Use the
  square icons (which carry `SURFACE` behind the mark) rather than `mark.svg`
  on white, or the cap has to be recoloured — which means regenerating, not
  editing the SVG.
- **The mark keeps its aspect ratio.** It is an equilateral-ish triangle, not
  a square; stretching it to a square profile flattens the summit. Square
  icons are the mark *centred on* a square, with 12% inset, not the mark
  distorted into one.
- **Do not re-space the wordmark by hand.** The tracking and the baseline
  placement are computed from Manrope's metrics in `generate.py`. Manual
  kerning in the output SVG is lost the next time anything is regenerated.
- **The byline is optional.** "Cartenz" alone is correct where the relationship
  is already established; "Cartenz by LinkedERP" is the full signature, used
  on first contact (sign-in, public pages).
- **Minimum size.** The mark holds down to 16 px (`icon-16.png`), which is why
  it is a single silhouette with no interior detail. The horizontal lockup
  needs about 120 px of width before the byline stops resolving.

## Font

Manrope ExtraBold, SIL Open Font License 1.1 (`Manrope-OFL.txt`). The `.ttf`
here is an **instanced static** file pinned to weight 800, produced from
Google's variable font — the variable original defaults to weight 200, so
using it un-instanced would silently produce a hairline wordmark. It is a
build-time input only and is deliberately not copied into
`frontend/public/`: the whole point of outlining the wordmark is that the
shipped asset depends on no font being installed.
