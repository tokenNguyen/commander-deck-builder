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
4. Every card shows its **estimated CAD price** underneath (basic lands show the price
   of one copy, marked "ea"), and the deck header adds up an **estimated value** for the
   whole deck. The total updates as you add, remove or swap cards. Cards with no price on
   any printing aren't counted, and the header says how many. If the exchange rate can't
   be loaded, everything shows in US dollars instead.
5. Click any card to open a details window over the page (the deck stays visible,
   dimmed, behind it) with a large image, an **estimated CAD price** (Scryfall's USD
   price converted at the day's rate from [Frankfurter](https://frankfurter.dev); real
   Canadian store prices are usually higher), and three tabs: official **Rulings**,
   **Combos** from Commander Spellbook, and **Replacements**, other popular cards for
   the same job that aren't in your deck yet, with a **Swap in** button that puts the
   new card in the old one's slot. Drag cards to add or remove them (see the hint
   above the deck). **Copy Decklist** copies a plain text list (works with Moxfield,
   Archidekt, TappedOut, etc.).
6. **Game Changers and estimated bracket.** Scryfall flags Wizards' Game Changer cards
   (`game_changer` on each card), so they get a gold **GC** badge on their tile, in the
   details window and in swap suggestions. Above the deck, an estimate of the deck's
   [Commander Bracket](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta)
   (2 Core, 3 Upgraded, 4 Optimized) is worked out from the Game Changer count
   (none = 2, up to three = 3, more = 4), mass land denial, extra-turn spells, and
   two-card combos (via Commander Spellbook: fast "Ruthless" ones push it to 4). It updates
   whenever you add, remove or swap a card. It's a guide only: it can't tell Bracket 1
   from 2 or 4 from 5.
7. **Target bracket at build time.** The **Target bracket** menu next to the archetype
   (2 Core, 3 Upgraded, or 4 with no limits, the default) makes **Build Deck** and
   **Rebuild** respect that bracket from the start. Restricted cards are skipped while
   picking, so the next-best card in each category takes the slot: Bracket 2 uses no Game
   Changers, Bracket 3 keeps the three most popular ones the deck would have picked, and
   both skip mass land denial and cap extra-turn spells at two. Two-card combos can't be
   ruled out card by card, so the finished deck is checked and one piece of any combo the
   target doesn't allow is swapped.
8. **Target bracket slider.** Drag it to another bracket and press **Adjust deck** to swap
   out whatever holds the deck above it: Game Changers beyond the target's limit (the
   least popular go first; cards you added yourself are kept longest), mass land denial,
   extra-turn spells beyond two, and one card from each two-card combo the target doesn't
   allow. Each is replaced in place by a popular card for the same job (the same search the
   Replacements tab uses) that has none of those traits, so the deck stays the same size.
   A note previews how many cards would change, "See what changed" lists every swap, and
   **Undo** restores the deck until you make another edit.

   It also works upward: drag it higher and the deck brings in Game Changers (enough for
   3 in Bracket 3, or 6 in Bracket 4), the most popular ones for the deck's colors. Each goes
   into the group that matches its job (Ramp, Removal, Card Draw, ...) in place of that
   group's least popular card; ones with no matching group replace the least popular
   "Creatures & Other Spells" card. Cards you added and the basic lands are left alone.
9. **Budget.** Give a budget in estimated CAD and the deck is trimmed to fit it, either at
   build time (the **Budget** box next to the target bracket) or on an existing deck (the
   **Budget** panel above the mana curve: type a number or drag the slider, then **Adjust to
   budget**). The trim is best-effort and goes in this order:
   - the same card in a cheaper printing (the play doesn't change, the art may),
   - a cheaper card for the same job from the same role searches the Replacements tab uses,
     with a price ceiling. When only a little needs saving it swaps the least popular card
     that saves enough; otherwise the priciest card first. Cards you added go last.

   When you build with a budget, each pick also has a per-card price ceiling so the
   next-best card takes the slot. **The bracket is a floor:** a swap that would drop the deck
   below its target bracket isn't made, and a Game Changer the bracket needs is swapped
   for a cheaper Game Changer instead. If the budget can't be met (for example the
   commander alone costs most of it), the panel says how close it got and why. "See what
   changed" lists every swap and **Undo** restores the deck until you edit it again. Each
   group heading also shows that group's estimated cost.

## The serverless proxy (`api/proxy.js`)

[Commander Spellbook](https://commanderspellbook.com) (combos) and
[Archidekt](https://archidekt.com) (popular decks for the selected commander) don't
allow requests straight from a browser, so `api/proxy.js` fetches them server-side.
Vercel deploys any file in `api/` as a function automatically, with no extra setup.

- It never takes a URL from the caller; each `target` (`spellbook`, `archidekt`, plus the
  POST-only `spellbook-bracket`, which checks a whole decklist for two-card combos) builds
  its own fixed upstream URL from validated parameters, so it can't be used as an open proxy.
- Responses are cached for six hours to keep usage (and load on those sites) low.
- The page treats it as optional: if `/api/proxy` isn't available, the Combos section
  and the Archidekt list just stay hidden, the bracket estimate leaves out two-card
  combos, and everything else works.

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
- No saving/exporting to a specific site format beyond plain text.
