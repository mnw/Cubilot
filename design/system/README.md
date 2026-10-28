# Cubilot

The design system of Cubilot, the continuous software foundry: a desktop and browser app where AI agents work through tickets while one person defines the work and checks the result. Built from the code (`ui/styles/tokens.css`, branch `staging`, 2026-10-28), so every value here is the value the app uses today, plus five role colours and two sizes that Part 14 of the brief adds.

## Character

Refined warm terminal. Cubilot is a control room for long-running work: dense, quiet, readable for hours. Warm near-black grounds instead of blue-grey, cream text instead of white, one orange accent for the thing you act on. Monospace where the content is machine output (times, ids, terminal), sans for everything a person reads, a serif only for the brand mark. Colour carries state (running, online, danger, role); it is never decoration.

## How the tokens are built

Two layers, and the split is a rule, not a convenience:

- **Skin** (the Colors view): grounds, lines, text, accents, overlays, the terminal palette. Each theme overrides only these. Three themes: **Warm dark** (default), **Rosé Pine Dawn** (light), **Rosé Pine Moon** (medium dark).
- **Structure** (every other view): type scale, spacing, sizes, borders, radius, z-index, shadows, motion. The same in every theme. A theme block never touches it.

Never write a colour outside the tokens. Never write a spacing, size or font size as a literal: extend the scale here instead. Names that are pixel values (`sp-12`, `size-300`) stay pixel values, so a migration from literals is mechanical.

## Grounds and lines

| Token | Use |
|---|---|
| `bg` | Window ground |
| `bg-inset` | Left rail, terminal ground, footer, inputs |
| `bg-raised` | Cards, composer, chips, modals |
| `bg-elev` | Selected row, active chip, overlays above raised |
| `bg-hover` | Hover fill |
| `line`, `line-soft`, `line-hover` | Default border, quiet border inside raised, border on hover |

Depth comes from these steps and from `line`, not from shadows. Shadows are for things that float: popovers, menus, modals, toasts.

## Text: four roles, one rule

| Token | Use | Contrast |
|---|---|---|
| `text` | Main text | 6:1 or more everywhere |
| `text-muted` | Secondary text | 4.5:1 or more on every surface, every theme |
| `text-meta` | Times, counts, section labels | 4.5:1 or more on every surface; in the Rosé Pine themes it equals `text-muted` |
| `text-dim` | Decoration only: separators, disabled controls | 2.2–3.0:1, never for information |

The rule: if a person needs to read it to act, it is `text`, `text-muted` or `text-meta`. `text-dim` was used for information until October 2026 (roster, nutshell, chat time, usage bar); those move to `text-meta`.

## Accents and state

- `orange`: the one thing to act on (Send, active tab line, primary button, focus), as a fill, line or mark. For accent words and links use `orange-text`, which is readable in every theme (in Rosé Pine Dawn `orange` itself is too light for text).
- `amber` running and warning, `green` online and success, `red` danger, `blue` information, `teal` and `purple` secondary status.
- On a tinted ground use the strong variant: `green-strong`, `red-strong`, `code-text`, `error-text`.
- Role colours (proposed, Part 14): `role-lead` → orange, `role-worker` → amber, `role-tester` → teal, `role-review` → purple, `role-other` → blue. They alias accents, so themes need no new values.
- Colours that must be told apart also differ in lightness; do not rely on red against green alone.

Many components mix tints from these accents with `color-mix()` (79 places in `ui/styles/`). The tints are not tokens; keep mixing from tokens, never from literals.

## Type

Inter (400, 500, 600) for the interface, JetBrains Mono (400, 500, 600) for machine text, Fraunces (400, 500, roman and italic) only for the brand mark and the nutshell display. The first family of `--sans` and `--mono` can be swapped by the user in `config.yml`; `--serif` cannot. The terminal uses CaskaydiaMono Nerd Font, inlined in `ui/styles/fonts.css` because xterm bakes glyphs at open time (not copied here: 2.7 MB a weight).

Six sizes, whole pixels (adopted 2026-10-28, replacing 13 half-pixel steps from 9 to 18 px that were too close to tell apart):

| Token | Size | Use |
|---|---|---|
| `fs-sm` | 12 px | metadata, badges, section labels, key hints: the minimum |
| `fs-base` | 14 px | desktop body, tables, buttons, chat messages |
| `fs-md` | 16 px | phone body, and every input on every device |
| `fs-lg` | 18 px | card titles, phone page titles, brand mark |
| `fs-xl` | 22 px | desktop page titles |
| `fs-2xl` | 28 px | rare: empty states, the delivery summary |

The terminal is outside the scale: 13 px desktop, 12 px phone, set in xterm. Every step multiplies by `--ui-font-scale` (`config.yml` `font_scale`), so a person can enlarge everything at once. Line heights: 1.4 tight, 1.5 body, 1.55 message bodies.

## Space, size, shape

- Spacing `sp-1` … `sp-48`: name = pixels. Use the smallest step that fits; gaps between siblings with flex or grid `gap`.
- Sizes `size-1` … `size-640`: component identity (a 6 px dot, a 300 px agent column), not breathing room.
- Radius: 6 px (`radius-lg`) for most cards, 12 px for chat bubbles, round for pills and dots. Part 14 keeps 6 px on cards (the mockup's 10 px is not adopted).
- Borders: 1 px everywhere, 3 px for a card's left marker (handoff, interrupt, permission).

## Motion

Not a token family here; the app has it in `tokens.css`: 0.1 s instant, 0.15 s for most micro-interactions, 0.2 s message fade-in, up to 0.35 s for a flash; slow loops (1.2 to 2.5 s) only for attention and status pulses. Respect reduced motion.

## Open findings (2026-10-28)

1. Contrast, fixed 2026-10-28 (approved by the human): `code-text` and `red-strong` in Dawn, `red-strong` in Moon, `text-meta` in both Rosé Pine themes (now equal to `text-muted`), and the new `orange-text`. Every text token now reaches 4.5:1 on every surface in every theme. Still to check on the mockups: label text on an orange fill (Send button). These values are not in `ui/styles/tokens.css` yet: a Worker ticket moves them, with the other Part 14 token changes.
2. The type scale changed (six sizes above). Part 14 maps the old `--fs-*` steps to it: 9–12.5 px → `fs-sm` or `fs-base` by role, 13–14 → `fs-base`, 16–18 → `fs-lg`.
3. Literals outside the tokens in `ui/styles/`: 14 hex colours (for example `#a78bfa`, `#444`, the window buttons `#ff5f57` and `#febc2e`), 2 rgba values, 10 font sizes and 55 spacing values in px.
4. Not tokens yet but proposed by Part 14: the five role colours, `size-56`, `size-248` (included here, marked proposed).

## Not synced

- `--agent-name-l` (lightness of an agent's name per theme: 75 %, 23 %, 80 %) is a per-theme number, not a colour; it stays in `tokens.css`.
- Motion tokens (no family for them here); `--ui-font-scale` and `--fs-terminal` (aliases).
- The CaskaydiaMono Nerd Font files. No components: Cubilot's UI is vanilla HTML, CSS and JS without a component library.
