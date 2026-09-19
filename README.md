# Commander Deck Builder

A static web app (no build step) that builds a prototypical 100-card Magic: The
Gathering Commander/EDH deck around a commander you pick, using live card data from
the [Scryfall API](https://scryfall.com/docs/api). One small serverless function
(`api/proxy.js`, see below) covers the two sites that block direct browser access.

## How it works

1. Type a commander name — it searches Scryfall (`is:commander`) as you type.
2. Pick a commander to see its color identity, rules text, and art.
3. **Build Deck** queries Scryfall for cards legal in that color identity, split into:
   - Ramp (10), Removal (8), Board Wipes (3), Card Draw (10) — found via Scryfall's
     community oracle tags (`otag:ramp`, `otag:removal`, `otag:board-wipe`, `otag:card-advantage`)
   - Creatures & Other Spells — filled from the general on-color pool (31)
   - Nonbasic Lands (up to 15, filtered so off-color fetch lands don't sneak in)
   - Basic Lands (fills out to 37 total lands, split by color pip weight across the deck)

   Everything is sorted by EDHREC popularity rank, so you get real, playable staples
   rather than random cards. **Rebuild** reruns the same pipeline for fresh picks.
4. Hover any card for a full-size preview with its combos and official rulings.
   **Copy Decklist** copies a plain text list (works with Moxfield, Archidekt,
   TappedOut, etc.).

## The serverless proxy (`api/proxy.js`)

[Commander Spellbook](https://commanderspellbook.com) (combos) and
[Archidekt](https://archidekt.com) (popular decks for the selected commander) don't
allow requests straight from a browser, so `api/proxy.js` fetches them server-side.
Vercel deploys any file in `api/` as a function automatically, with no extra setup.

- It never takes a URL from the caller; each `target` (`spellbook`, `archidekt`) builds
  its own fixed upstream URL from validated parameters, so it can't be used as an open proxy.
- Responses are cached for six hours to keep usage (and load on those sites) low.
- The page treats it as optional: if `/api/proxy` isn't available, the Combos section
  and the Archidekt list just stay hidden and everything else works.

## Running it

`serve.ps1` is a tiny PowerShell static file server:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open `http://localhost:8177` in a browser. (`npx serve` or `python -m http.server`
work too — just open `index.html` through a local server, not `file://`.) A static
server doesn't run `api/proxy.js`, so locally the combos and Archidekt list stay
hidden; they work once deployed to Vercel (or with `vercel dev`).

## Notes / limitations

- Categorization leans on Scryfall's crowdsourced oracle tags, which are good but not
  exhaustive — obscure commanders may get a thinner "Creatures & Other Spells" pool.
- This is a *starting point* deck, not a tuned build — swap cards to taste.
- No card prices, no saving/exporting to a specific site format beyond plain text.
