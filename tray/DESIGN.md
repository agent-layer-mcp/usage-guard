# Usage Guard tray: design notes

The panel follows the Agent Layer brand as used on https://agentlayer.sh
(analysed 2026-10-20 from its computed styles). The site has no dark mode, so
neither does the panel.

## Tokens ("paper")

| Role | Value |
| --- | --- |
| Canvas / card / tint | `#F4F1EA` / `#FFFFFF` / `#EDE8DE` |
| Inkwell (dark surfaces, primary buttons) | `#26221D`, text on it `#FBF9F5` |
| Text primary / secondary / tertiary | `#26221D` / `#6F6A62` / `#A39D93` |
| Hairline / strong stroke | `rgba(38,34,29,.12)` / `rgba(38,34,29,.22)` |
| Accent "seal" (also bad) / good / warn | `#C2452D` / `#5F8F6B` / `#B07A45` |
| Module colours (used for lanes) | home `#B07A45` Claude, money `#4E6E8E` Codex, life `#8E5F7E` Hermes |
| Radii | card 14–16, control 10, chip 999, stamp 5 |
| Shadows | card `0 1px 3px rgba(38,34,29,.05)`, float `0 4px 16px rgba(38,34,29,.08)` |

## Type

- Sans: Inter 400–700 (bundled at `ui/fonts/Inter-latin.woff2`, SIL OFL; no CDN at runtime).
- Serif: Iowan Old Style → Palatino → Charter → Georgia, for the "agent layer"
  wordmark (500, −0.9px) and the italic seal-red accent word in headlines.
- Mono: ui-monospace / SF Mono / Menlo for eyebrows, captions, stamps and numbers.
- Headline: Inter 700, tight tracking (−1px), with one serif-italic accent word.
- Eyebrow: mono 10.5px, uppercase, wide tracking, tertiary colour, `·` separators.

## Components

- Status pill: white, hairline border, chip radius, mono 10.5px, 7px dot.
  Used as the on/off switch (dot turns green when on).
- Stamp: mono 9px uppercase, 2px tracking, 1px current-colour border, radius 5
  (the site's "SEALED" tag). Used for lane state.
- Buttons: pill radius, Inter 600 14.5px; primary is inkwell filled, secondary
  is a strong-stroke outline.
- Cards: white, hairline border, card shadow, ~22px padding.
- Ink card: inkwell background for the one most important fact (the next job's lane).
- Mark: three flat planes forming a layered A (`agent-layer-mark.svg`), also the tray icon.

## Tone

Short, calm, plain sentences; lowercase mono captions; one emphasised idea per
heading ("Your week, *paced.*").

## Files

- `design-ref/panel-on.png`, `design-ref/panel-off.png`: the panel rendered
  with sample data.
- Site screenshots and og.png are kept locally in `design-ref/` (not committed).
