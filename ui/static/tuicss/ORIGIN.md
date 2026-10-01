# origin of the tui assets

copied 2026-09-18 from the **uncommitted working tree** of `galacticcouncil/rpc-status` at a565558. `static/` is untracked there (`git ls-files static` is empty, `git status --short` shows `?? static/`), so no upstream commit holds these bytes yet. PR-0b commits them to rpc-status; until then this directory is the source of truth and a fresh clone of this repo builds from here. do not hand-edit — re-vendor.

## files

| file | sha256 | upstream |
|---|---|---|
| `tuicss.min.css` | `c4dce802b31b08fb08a6d71972dbbd4ce7748b2a3fba30a635d35e6858edbe41` | jsDelivr's clean-css 5.3.3 minification of TuiCss 2.1.2 `dist/tuicss.css` (says so in its own header). not byte-identical to the repo's `dist/tuicss.min.css` (git blob `a99923fc`), same source |
| `fonts/Perfect DOS VGA 437 Win.ttf` | `7462d98421919395fb21f4915ed975b4b3d88dec51d3ad1f27b780fa4564ed7d` | byte-identical to TuiCss v2.1.2 `dist/fonts/Perfect DOS VGA 437 Win.ttf` (git blob `d03b1c5e5780554a44cf7c8caf03d0da38d4de25`) |
| `fonts/dos437.txt` | `3d15a62f46ad74c886d6670a72bc9e8926af865927b00f7b44bdc3fbdeea6c63` | the font author's readme, byte-identical to TuiCss v2.1.2 `dist/fonts/dos437.txt` (git blob `d4860e2b1809f7d4889edf9fad6df6c334cd0203`); latin-1 encoded upstream, kept as is |
| `images/bg-blue-black.png` | `106f95edd9c6dd01a1d43cc7011fa80df3805acba5bcbc30ea065ef7a2a8d8c2` | byte-identical to TuiCss v2.1.2 `dist/images/bg-blue-black.png` (git blob `aa55706d4fc2a01a606f1c91cbaaedda135a476b`). unused by app.css (the desktop dither is a themed gradient); kept because the rpc-status tree ships it |
| `LICENSE-tuicss.md` | — | TuiCss `LICENSE.md` (git blob `e477129d5ee443a23b729b62b592a44328e8328e`), fetched 2026-09-18 from github.com/vinibiavatti1/TuiCss |

TuiCss v2.1.2 is tag `v2.1.2` = `6a021ecc2abb1fbe6da62bd370d1f2a764da1195`.

## tuicss

[TuiCss](https://github.com/vinibiavatti1/TuiCss) by Vinicius Reif Biavatti, MIT — the licence text is `LICENSE-tuicss.md` alongside. `app.css` imports the stylesheet from `/tuicss/tuicss.min.css`; the stylesheet declares the font under the family name `DOS` with a relative `fonts/` url, which is why the directory layout must stay exactly as it is.

## font

"Perfect DOS VGA 437 Win" by Zeh Fernando (2008 update; the two-variant story is in `fonts/dos437.txt`, his own readme). no licence text ships with the font: the rpc-status tree had none, and the readme has no licence clause. it is distributed as freeware — dafont lists it as 100% free (public domain / GPL / OFL category) — and TuiCss has redistributed it inside its MIT tree since 2019. the `Win` variant is the windows-codepage build: accented latin works, the cp437 control-range pictures do not.

what the font can draw is the contract for every rendered line (`server/contract/glyphs.ts`, `fc-scan --format '%{charset}'` on this file, 2026-09-18): 255 code points — ascii, single box drawing `─│┌┐└┘├┤┬┴┼`, double and mixed `U+2550-256C`, blocks `▀▄█▌▐░▒▓`, `■ √ ≡ ± ≥ ≤ · ° ² ∞ ½ ¼ « » ÷ ≈ ∙`, some Greek, cp437 latin-1. **missing:** `► ◄ ▲ ▼ • ○ ● ↑ ↓ → ← ↔ ✓ ✗ ⚠ ◊ ▁▂▃▅▆▇ ▾ ▸ — … × § ¶ ‼`. help text writes `Up/Down`, charts use `▄ █ ▀ ░ ▒ ▓` only, and keeper/monitor glyphs are mapped at render time (`✓→√ ⚠→! —→- …→..`).
