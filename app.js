// Commander Deck Builder
// All card data comes live from the Scryfall API (https://scryfall.com/docs/api).

const SCRYFALL = "https://api.scryfall.com";

// Deck skeleton: how many of each category to aim for (99 nonland + commander = 100).
const DEFAULT_TARGETS = {
  ramp: 10,
  removal: 8,
  wipe: 3,
  draw: 10,
  nonbasicLands: 15,
  totalLands: 37,
};

// Archetypes bias card selection toward a theme via Scryfall oracle-tag / text queries,
// verified live against the API so every tag here actually returns results.
// `targets` (optional) overrides the skeleton counts above for that archetype.
// `synergyQuery` (optional) is ANDed onto the legal/color-identity filter to pull a themed
// pool, sorted by EDHREC rank, before the rest of the deck is filled with general goodstuff.
const ARCHETYPES = {
  balanced: {
    label: "Balanced (Goodstuff)",
    description: "Efficient staples and EDHREC's top picks — no particular theme, just power.",
  },
  aggro: {
    label: "Aggro",
    description: "Low curve, go for the throat. Fewer wipes and less ramp, more cheap threats.",
    targets: { ramp: 6, removal: 8, wipe: 0, draw: 6, nonbasicLands: 12, totalLands: 35 },
    synergyQuery: "(otag:attack-trigger or otag:extra-combat)",
    synergyCount: 14,
    extraFilter: "cmc<=4",
  },
  control: {
    label: "Control",
    description: "Answer everything, draw more cards, win the long game.",
    targets: { ramp: 8, removal: 10, wipe: 5, draw: 12, nonbasicLands: 15, totalLands: 38 },
    synergyQuery: "otag:counterspell",
    synergyCount: 10,
  },
  aristocrats: {
    label: "Aristocrats",
    description: "Sacrifice your own creatures for value — death triggers do the work.",
    synergyQuery: "(otag:sacrifice-outlet or otag:death-trigger)",
    synergyCount: 18,
  },
  reanimator: {
    label: "Reanimator / Graveyard",
    description: "Mill or discard big threats, then cheat them into play from the graveyard.",
    synergyQuery: "(otag:reanimate or otag:recursion or otag:self-mill)",
    synergyCount: 18,
  },
  tokens: {
    label: "Tokens (Go Wide)",
    description: "Flood the board with creature tokens, then pump the whole team at once.",
    synergyQuery: '(o:"create" o:"token" -t:token)',
    synergyCount: 18,
  },
  voltron: {
    label: "Voltron",
    description: "Suit up one creature with equipment and auras, swing for commander damage.",
    synergyQuery: "(t:equipment or t:aura or otag:evasion or otag:unblockable)",
    synergyCount: 18,
  },
  spellslinger: {
    label: "Spellslinger",
    description: "Instants and sorceries trigger big payoffs as you cast them.",
    synergyQuery: "(otag:cast-trigger or otag:magecraft or otag:copy-spell)",
    synergyCount: 18,
  },
  counters: {
    label: "+1/+1 Counters",
    description: "Grow your board with counters, then proliferate them out of control.",
    synergyQuery: '(otag:counters-matter or o:"proliferate")',
    synergyCount: 18,
  },
  lifegain: {
    label: "Lifegain",
    description: "Gain huge amounts of life and cash it in for value.",
    synergyQuery: "(otag:lifegain or otag:lifedrain)",
    synergyCount: 18,
  },
  tribal: {
    label: "Tribal (auto-detect)",
    description: "Built around the commander's own creature type(s), if it has any.",
    dynamicTribal: true,
    synergyCount: 18,
  },
};

const BASIC_LAND_NAME = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };

let selectedCommander = null;
let currentDeck = null;
let dragState = null; // { type: 'add', card } | { type: 'remove', group, index }
let viewMode = "function"; // 'function' | 'type' — how deck-groups are grouped for display
let searchAbortToken = 0;

const el = (id) => document.getElementById(id);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scryfallSearch(query, { limit = 175 } = {}) {
  const cards = [];
  let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(query)}&unique=cards`;
  let guard = 0;
  while (url && cards.length < limit && guard < 5) {
    guard++;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) return []; // no matches, not an error
      throw new Error(`Scryfall search failed (${res.status})`);
    }
    const data = await res.json();
    cards.push(...data.data);
    url = data.has_more ? data.next_page : null;
    if (url) await sleep(80);
  }
  return cards.slice(0, limit);
}

async function fetchCardByName(name) {
  try {
    const res = await fetch(`${SCRYFALL}/cards/named?exact=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Basic land entries start as plain {name, qty} — fetch each distinct basic's real
// card data once so it renders as an actual card image, not a placeholder box.
async function fetchBasicLandCards(entries, cache = new Map()) {
  const result = [];
  for (const entry of entries) {
    if (!cache.has(entry.name)) {
      cache.set(entry.name, await fetchCardByName(entry.name));
      await sleep(80);
    }
    const card = cache.get(entry.name);
    result.push(card ? { ...card, qty: entry.qty } : { name: entry.name, qty: entry.qty });
  }
  return result;
}

// ---------- Commander search UI ----------

const input = el("commander-input");
const resultsBox = el("search-results");

input.addEventListener("input", () => {
  const q = input.value.trim();
  if (q.length < 2) {
    resultsBox.classList.add("hidden");
    resultsBox.innerHTML = "";
    return;
  }
  const myToken = ++searchAbortToken;
  debounceSearch(q, myToken);
});

let debounceTimer = null;
function debounceSearch(q, token) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runCommanderSearch(q, token), 280);
}

async function runCommanderSearch(q, token) {
  try {
    const escaped = q.replace(/"/g, '\\"');
    const cards = await scryfallSearch(`is:commander ("${escaped}") order:edhrec`, { limit: 8 });
    if (token !== searchAbortToken) return; // stale response
    renderResults(cards);
  } catch (e) {
    if (token !== searchAbortToken) return;
    resultsBox.innerHTML = `<div class="result-empty">Search error: ${escapeHtml(e.message)}</div>`;
    resultsBox.classList.remove("hidden");
  }
}

function renderResults(cards) {
  if (!cards.length) {
    resultsBox.innerHTML = `<div class="result-empty">No legal commanders found.</div>`;
    resultsBox.classList.remove("hidden");
    return;
  }
  resultsBox.innerHTML = "";
  cards.forEach((card) => {
    const row = document.createElement("div");
    row.className = "result-row";
    const img = cardArt(card, "small");
    row.innerHTML = `
      <img src="${img || ""}" alt="" onerror="this.style.visibility='hidden'"/>
      <div>
        <div class="r-name">${escapeHtml(card.name)}</div>
        <div class="r-type">${escapeHtml(card.type_line || "")}</div>
      </div>`;
    row.addEventListener("click", () => selectCommander(card));
    resultsBox.appendChild(row);
  });
  resultsBox.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) {
    resultsBox.classList.add("hidden");
  }
});

function cardArt(card, size = "normal") {
  if (card.image_uris) return card.image_uris[size];
  if (card.card_faces && card.card_faces[0].image_uris) return card.card_faces[0].image_uris[size];
  return null;
}

function cardManaCost(card) {
  if (card.mana_cost) return card.mana_cost;
  if (card.card_faces) return card.card_faces.map((f) => f.mana_cost || "").join(" // ");
  return "";
}

function cardCmc(card) {
  return typeof card.cmc === "number" ? card.cmc : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Commander selection ----------

// Official mana symbols, hosted by Scryfall. Scryfall lists color identity alphabetically;
// Magic's own order is W, U, B, R, G.
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless" };
function renderColorSymbols(identity) {
  const known = (identity || []).filter((c) => "WUBRG".includes(c));
  const colors = known.length ? [...known].sort((a, b) => "WUBRG".indexOf(a) - "WUBRG".indexOf(b)) : ["C"];
  const row = el("commander-colors");
  row.innerHTML = "";
  colors.forEach((c) => {
    const img = document.createElement("img");
    img.className = "mana-symbol";
    img.src = `https://svgs.scryfall.io/card-symbols/${c}.svg`;
    img.alt = COLOR_NAMES[c];
    img.title = COLOR_NAMES[c];
    row.appendChild(img);
  });
}

function selectCommander(card) {
  selectedCommander = card;
  resultsBox.classList.add("hidden");
  input.value = card.name;

  el("commander-image").src = cardArt(card, "normal") || "";
  el("commander-name").textContent = card.name;
  el("commander-type").textContent = card.type_line || "";
  el("commander-text").textContent = card.oracle_text || (card.card_faces ? card.card_faces.map((f) => f.oracle_text).join("\n---\n") : "");

  renderColorSymbols(card.color_identity);

  populateArchetypeSelect(card, []);
  el("commander-panel").classList.remove("hidden");
  el("deck-panel").classList.add("hidden");

  fetchCommanderThemes(card).then((themes) => {
    if (!selectedCommander || selectedCommander.id !== card.id) return; // commander changed again meanwhile
    populateArchetypeSelect(card, themes);
  });
}

el("change-btn").addEventListener("click", () => {
  el("commander-panel").classList.add("hidden");
  el("deck-panel").classList.add("hidden");
  input.value = "";
  input.focus();
});

el("build-btn").addEventListener("click", () => buildDeck());
el("reroll-btn").addEventListener("click", () => buildDeck());

// ---------- Archetype selector ----------
//
// Beyond the curated ARCHETYPES above, we fetch this specific commander's own theme
// tags from EDHREC (the same "Themes" shown on a commander's EDHREC page, e.g. Atraxa
// gets Infect / Superfriends / Proliferate) and offer those too. Picking one pulls that
// exact commander+theme's EDHREC card recommendations for the synergy pool at build time,
// so the cards really do reinforce that specific archetype for that specific commander —
// not just a generic Scryfall tag search. This is an unofficial API, so every call here
// fails soft: if EDHREC is unreachable, the curated archetypes still work as before.

const bracketSelect = el("bracket-select");
const BRACKET_SELECT_TEXT = {
  2: "No Game Changers, no mass land denial, at most two extra-turn spells, and no two-card combos.",
  3: "Up to three Game Changers (the most popular ones the deck picks), no mass land denial, at most two extra-turn spells, and no fast two-card combos.",
  4: "No limits: the most popular cards for the commander.",
};
function updateBracketSelectDesc() {
  el("bracket-select-desc").textContent = BRACKET_SELECT_TEXT[bracketSelect.value] || "";
}
bracketSelect.addEventListener("change", updateBracketSelectDesc);
updateBracketSelectDesc();

const archetypeSelect = el("archetype-select");
let dynamicArchetypes = {}; // populated per-commander from EDHREC; keys look like "edhrec:<slug>"
const commanderThemeCache = new Map();

function resolveArchetype(key) {
  return ARCHETYPES[key] || dynamicArchetypes[key] || ARCHETYPES.balanced;
}

function edhrecSlug(name) {
  return name
    .toLowerCase()
    .replace(/\/\//g, "")
    .replace(/[',]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchCommanderThemes(card) {
  if (commanderThemeCache.has(card.id)) return commanderThemeCache.get(card.id);
  const slug = edhrecSlug(card.name);
  const promise = (async () => {
    try {
      const res = await fetch(`https://json.edhrec.com/pages/commanders/${slug}.json`);
      if (!res.ok) return [];
      const data = await res.json();
      const links = (data.panels && data.panels.taglinks) || [];
      return links.map((t) => ({ slug: t.slug, label: t.value, count: t.count }));
    } catch {
      return [];
    }
  })();
  commanderThemeCache.set(card.id, promise);
  return promise;
}

// Fetches the card pools EDHREC shows for one specific commander + theme combination
// (its "Creatures", "Instants", "Mana Artifacts", "High Synergy Cards" sections, etc.),
// keyed by their tag. Used to bias deck-building toward that exact theme, not just a
// small "synergy" slice of the deck.
async function fetchEdhrecThemeData(commanderSlug, themeSlug) {
  const res = await fetch(`https://json.edhrec.com/pages/commanders/${commanderSlug}/${themeSlug}.json`);
  if (!res.ok) throw new Error(`EDHREC theme page unavailable (${res.status})`);
  const data = await res.json();
  const cardlists = (data.container && data.container.json_dict && data.container.json_dict.cardlists) || [];
  const byTag = {};
  cardlists.forEach((c) => {
    byTag[c.tag] = c.cardviews || [];
  });
  return byTag;
}

function collectThemeIds(byTag, tags, capPerTag) {
  const seen = new Set();
  const ids = [];
  tags.forEach((tag) => {
    (byTag[tag] || []).slice(0, capPerTag).forEach((cv) => {
      if (cv.id && !seen.has(cv.id)) {
        seen.add(cv.id);
        ids.push(cv.id);
      }
    });
  });
  return ids;
}

// Scryfall's collection endpoint resolves up to 75 identifiers per request.
async function resolveCardsByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75).map((id) => ({ id }));
    const res = await fetch(`${SCRYFALL}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk }),
    });
    if (res.ok) {
      const data = await res.json();
      out.push(...(data.data || []));
    }
    if (i + 75 < ids.length) await sleep(80);
  }
  return out;
}

function populateArchetypeSelect(commander, themes) {
  const previousValue = archetypeSelect.value;
  archetypeSelect.innerHTML = "";
  dynamicArchetypes = {};

  Object.entries(ARCHETYPES).forEach(([key, a]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = a.label;
    archetypeSelect.appendChild(opt);
  });

  const curatedLabels = new Set(Object.values(ARCHETYPES).map((a) => normalizeName(a.label)));
  const commanderSlug = edhrecSlug(commander.name);
  const freshThemes = themes.filter((t) => !curatedLabels.has(normalizeName(t.label))).slice(0, 14);

  if (freshThemes.length) {
    const group = document.createElement("optgroup");
    group.label = `${commander.name}'s EDHREC themes`;
    freshThemes.forEach((t) => {
      const key = `edhrec:${t.slug}`;
      dynamicArchetypes[key] = {
        label: t.label,
        description: `An EDHREC theme for ${commander.name} — seen in ${t.count.toLocaleString()} decks. Synergy cards are pulled live from EDHREC for this exact commander + theme.`,
        dynamicEdhrec: true,
        commanderSlug,
        themeSlug: t.slug,
        synergyCount: 18,
      };
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = t.label;
      group.appendChild(opt);
    });
    archetypeSelect.appendChild(group);
  }

  archetypeSelect.value = [...archetypeSelect.options].some((o) => o.value === previousValue) ? previousValue : "balanced";
  updateArchetypeDesc();
}

function updateArchetypeDesc() {
  const a = resolveArchetype(archetypeSelect.value);
  el("archetype-desc").textContent = a.description || "";
}
archetypeSelect.addEventListener("change", updateArchetypeDesc);
populateArchetypeSelect({ name: "" }, []);
updateArchetypeDesc();

// Creature subtypes after the em dash in a type line, e.g. "Legendary Creature — Human Wizard"
// -> ["Human", "Wizard"]. Used by the Tribal archetype to build a t:"<type>" search.
function getCreatureSubtypes(card) {
  const typeLine = card.type_line || "";
  const parts = typeLine.split("—");
  if (parts.length < 2) return [];
  return parts[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// ---------- Deck building ----------

function identityQueryFragment(identity) {
  if (!identity.length) return "id=c";
  return `id<=${identity.join("")}`;
}

async function setStatus(text) {
  el("status-text").textContent = text;
  await sleep(10); // let the DOM paint
}

async function buildDeck() {
  if (!selectedCommander) return;
  el("build-btn").disabled = true;
  el("status-panel").classList.remove("hidden");
  el("deck-panel").classList.add("hidden");

  try {
    const archetype = resolveArchetype(archetypeSelect.value);
    const bracketTarget = Number(bracketSelect.value) || 4;
    const budget = parseBudget(el("build-budget").value); // estimated CAD, or null for no limit
    const basicCache = new Map(); // basic land card data, fetched once however many passes run
    const targets ={ ...DEFAULT_TARGETS, ...(archetype.targets || {}) };
    const extraFilter = archetype.extraFilter ? ` ${archetype.extraFilter}` : "";

    const identity = selectedCommander.color_identity || [];
    const idFrag = identityQueryFragment(identity);
    const legalBase = `${idFrag} legal:commander -is:commander game:paper`;

    // For a dynamic EDHREC archetype, pull that exact commander+theme's card pools up
    // front so every category below leans on real EDHREC data, not just a small
    // "synergy" slice — this is what actually makes a deck feel built around the theme.
    let themePools = null; // { synergy, ramp, lands, fill }
    let themeNameSet = null; // every card name EDHREC associates with this commander+theme
    let themeNote = "";
    if (archetype.dynamicEdhrec) {
      await setStatus(`Loading ${archetype.label} data from EDHREC...`);
      try {
        const byTag = await fetchEdhrecThemeData(archetype.commanderSlug, archetype.themeSlug);
        const idGroups = {
          synergy: collectThemeIds(byTag, ["highsynergycards", "topcards", "gamechangers"], 15),
          ramp: collectThemeIds(byTag, ["manaartifacts"], 20),
          lands: collectThemeIds(byTag, ["utilitylands", "lands"], 25),
          fill: collectThemeIds(byTag, ["creatures", "instants", "sorceries", "utilityartifacts", "enchantments", "planeswalkers"], 30),
        };
        const allIds = [...new Set(Object.values(idGroups).flat())];
        await setStatus(`Resolving ${archetype.label} cards from EDHREC...`);
        const resolved = (await resolveCardsByIds(allIds)).filter((c) => isColorLegal(c, identity));
        const cardById = new Map(resolved.map((c) => [c.id, c]));
        const mapIds = (ids) => ids.map((id) => cardById.get(id)).filter(Boolean);
        themePools = {
          synergy: mapIds(idGroups.synergy),
          ramp: mapIds(idGroups.ramp),
          lands: mapIds(idGroups.lands),
          fill: mapIds(idGroups.fill),
        };
        themeNameSet = new Set(resolved.map((c) => normalizeName(c.name)));
      } catch (err) {
        console.error(err);
        themeNote = "Couldn't load EDHREC data for this theme — used goodstuff picks instead.";
      }
      await sleep(90);
    }

    // Moves any on-theme card to the front of a category's candidate pool. It never
    // narrows the pool, so a deck still gets a full, functional set of removal/draw/etc.
    // even when the theme itself has little to say about that category. A no-op for
    // every archetype except a dynamic EDHREC one (themeNameSet stays null otherwise).
    const prioritizeByTheme = (pool) => {
      if (!themeNameSet || !themeNameSet.size) return pool;
      const onTheme = [];
      const rest = [];
      pool.forEach((c) => (themeNameSet.has(normalizeName(c.name)) ? onTheme : rest).push(c));
      return [...onTheme, ...rest];
    };

    // Scryfall's answers are remembered for this build, so a second pass costs no requests.
    const searchMemo = new Map();
    const search = (query, opts = {}) => {
      const key = `${opts.limit}|${query}`;
      if (!searchMemo.has(key)) searchMemo.set(key, scryfallSearch(query, opts));
      return searchMemo.get(key);
    };

    // One full pass of picking the 99. `allowGc` is the set of Game Changer names that may be
    // picked (null for any), so a target bracket can rule cards out before they are chosen
    // rather than after: the next-best card in each pool takes the slot instead.
    const assemble = async (allowGc, capUsd = Infinity) => {
      const used = new Set([normalizeName(selectedCommander.name)]);
      let extraTurns = 0;
      let synergyNote = themeNote;

      // With a budget, cards priced above `capUsd` are passed over so the next-best card takes
      // the slot. Game Changers are exempt: the budget trim handles those, because the target
      // bracket may need some of them. A card with no price on its shown printing is allowed.
      const withinCap = (c) => {
        if (capUsd === Infinity || c.game_changer) return true;
        const price = cardPrices(c)[0];
        return !price || price.usd <= capUsd;
      };

      // Bracket 4 has no card limits. Below it: no mass land denial, at most two extra-turn
      // spells (the same limits the bracket estimate uses), and only the allowed Game Changers.
      const isAllowed = (c) => {
        if (!withinCap(c)) return false;
        if (bracketTarget >= 4) return true;
        if (MASS_LAND_DENIAL.has(frontFace(c.name).toLowerCase())) return false;
        if (c.game_changer && allowGc && !allowGc.has(c.name)) return false;
        if (isExtraTurnCard(c) && extraTurns >= 2) return false;
        return true;
      };

      const takeFresh = (pool, n) => {
        const picked = [];
        for (const c of pool) {
          const key = normalizeName(c.name);
          if (used.has(key) || !isAllowed(c)) continue;
          used.add(key);
          if (isExtraTurnCard(c)) extraTurns++;
          picked.push(c);
          if (picked.length >= n) break;
        }
        return picked;
      };

      await setStatus("Finding ramp...");
      const rampCandidates = [...(themePools?.ramp || []), ...(await search(`${legalBase} otag:ramp order:edhrec`, { limit: 60 }))];
      const ramp = takeFresh(rampCandidates, targets.ramp);
      await sleep(90);

      await setStatus("Finding removal...");
      const removalPool = prioritizeByTheme(await search(`${legalBase} otag:removal order:edhrec`, { limit: 60 }));
      const removal = takeFresh(removalPool, targets.removal);
      await sleep(90);

      let wipe = [];
      if (targets.wipe > 0) {
        await setStatus("Finding board wipes...");
        const wipePool = prioritizeByTheme(await search(`${legalBase} otag:board-wipe order:edhrec`, { limit: 40 }));
        wipe = takeFresh(wipePool, targets.wipe);
        await sleep(90);
      }

      await setStatus("Finding card draw...");
      const drawPool = prioritizeByTheme(await search(`${legalBase} otag:card-advantage order:edhrec`, { limit: 60 }));
      let draw = takeFresh(drawPool, targets.draw);
      if (draw.length < targets.draw) {
        const drawPool2 = prioritizeByTheme(await search(`${legalBase} otag:card-draw order:edhrec`, { limit: 60 }));
        draw = draw.concat(takeFresh(drawPool2, targets.draw - draw.length));
      }
      await sleep(90);

      await setStatus("Finding nonbasic lands...");
      const landCandidates = [
        ...(themePools?.lands || []),
        ...(await search(`${idFrag} legal:commander t:land -t:basic game:paper order:edhrec`, { limit: 60 })),
      ];
      const relevantLandPool = landCandidates.filter((c) => isLandRelevant(c, identity));
      const nonbasicLands = takeFresh(relevantLandPool, targets.nonbasicLands);
      await sleep(90);

      const fixedNonland = ramp.length + removal.length + wipe.length + draw.length;
      const fillNeeded = Math.max(0, 99 - targets.totalLands - fixedNonland);

      // Archetype synergy pool: pulls themed cards (sacrifice outlets, token makers, etc.)
      // before the general goodstuff pool fills whatever's left.
      let synergy = [];
      if (archetype.dynamicTribal) {
        const tribalTypes = getCreatureSubtypes(selectedCommander);
        if (tribalTypes.length) {
          synergyNote = `Tribal theme: ${tribalTypes.join(", ")}`;
          await setStatus(`Finding ${tribalTypes.join("/")} tribal cards...`);
          const tribalQuery = `(${tribalTypes.map((t) => `t:"${t}"`).join(" or ")})`;
          const pool = await search(`${legalBase} ${tribalQuery} order:edhrec`, { limit: 60 });
          synergy = takeFresh(pool, Math.min(archetype.synergyCount, fillNeeded));
          await sleep(90);
        } else {
          synergyNote = "No creature type detected on this commander — used goodstuff picks instead.";
        }
      } else if (archetype.dynamicEdhrec) {
        if (themePools && themePools.synergy.length) {
          synergy = takeFresh(themePools.synergy, Math.min(archetype.synergyCount, fillNeeded));
        }
        if (!synergy.length && !synergyNote) {
          synergyNote = "No EDHREC synergy cards found for this theme in your colors — used goodstuff picks instead.";
        }
      } else if (archetype.synergyQuery) {
        await setStatus(`Finding ${archetype.label} synergy cards...`);
        const pool = await search(`${legalBase} ${archetype.synergyQuery}${extraFilter} order:edhrec`, { limit: 60 });
        synergy = takeFresh(pool, Math.min(archetype.synergyCount, fillNeeded));
        await sleep(90);
      }

      await setStatus("Rounding out the rest of the deck...");
      const generalFillNeeded = fillNeeded - synergy.length;
      // The theme's own Creatures/Instants/Sorceries/Artifacts/Enchantments/Planeswalkers
      // lists are the primary fill source for a dynamic EDHREC archetype — this is the
      // category that used to be 100% generic regardless of the chosen theme. The plain
      // Scryfall pool below only fills in if that runs short (rare, but always fetched
      // for every other archetype exactly as before).
      let fill = themePools ? takeFresh(themePools.fill, generalFillNeeded) : [];
      let fillPool = null;
      const ensureFillPool = async () => {
        if (!fillPool) fillPool = await search(`${legalBase} -t:land${extraFilter} order:edhrec`, { limit: 200 });
        return fillPool;
      };
      if (fill.length < generalFillNeeded) {
        const pool = await ensureFillPool();
        fill = fill.concat(takeFresh(pool, generalFillNeeded - fill.length));
      }

      // If any category came up short (small/obscure color identity), pad from the general pool.
      let shortfall = 99 - targets.totalLands - (fixedNonland + synergy.length + fill.length);
      if (shortfall > 0) {
        const pool = await ensureFillPool();
        fill.push(...takeFresh(pool, shortfall));
        shortfall = 99 - targets.totalLands - (fixedNonland + synergy.length + fill.length);
      }

      await setStatus("Balancing the mana base...");
      const nonlandCards = [...ramp, ...removal, ...wipe, ...draw, ...synergy, ...fill];
      const basicsNeeded = Math.max(0, targets.totalLands - nonbasicLands.length);
      const basics = buildBasicLands(identity, [...nonlandCards, selectedCommander], basicsNeeded);

      await setStatus("Fetching basic land art...");
      const basicCards = await fetchBasicLandCards(basics.entries, basicCache);

      const groups = [
        { name: "Ramp", cards: ramp },
        { name: "Removal", cards: removal },
        { name: "Board Wipes", cards: wipe },
        { name: "Card Draw", cards: draw },
      ];
      if (synergy.length) groups.push({ name: `${archetype.label} Synergy`, cards: synergy });
      groups.push(
        { name: "Creatures & Other Spells", cards: fill },
        { name: "Added Cards", cards: [], isAdded: true },
        { name: "Nonbasic Lands", cards: nonbasicLands },
        { name: "Basic Lands", cards: basicCards, isBasics: true }
      );

      return {
        commander: selectedCommander,
        archetypeLabel: archetype.label,
        synergyNote,
        identity,
        groups,
      };
    };

    // Bracket 2 allows no Game Changers. Bracket 3 allows three: build once with any allowed,
    // then, if the deck ran past that, build again keeping only the most popular of the ones
    // it picked (the commander itself counts if it is one).
    const assembleForBracket = async (capUsd) => {
      let d = await assemble(bracketTarget === 2 ? new Set() : null, capUsd);
      if (bracketTarget === 3) {
        const room = Math.max(0, 3 - (selectedCommander.game_changer ? 1 : 0));
        const picked = d.groups.flatMap((g) => g.cards).filter((c) => c.game_changer);
        if (picked.length > room) {
          await setStatus("Trimming Game Changers for Bracket 3...");
          picked.sort((a, b) => (a.edhrec_rank ?? 1e9) - (b.edhrec_rank ?? 1e9));
          d = await assemble(new Set(picked.slice(0, room).map((c) => c.name)), capUsd);
        }
      }
      return d;
    };

    // With a budget, find the highest per-card price ceiling whose deck (leaving the Game
    // Changers aside) fits. It starts from a guess and moves up or down a few steps; the trim
    // below then settles whatever is left, including the Game Changers.
    const budgetFx = budget ? await fetchUsdToCad() : null;
    const CAP_TIERS = [1, 2, 3, 5, 8, 12, 20, 35, 60, Infinity];
    let deck;
    if (budget && budgetFx) {
      const commanderUsd = (cardPrices(selectedCommander)[0] || { usd: 0 }).usd;
      const perCard = Math.max(0.5, (budget / budgetFx.rate - commanderUsd) / 99);
      let tier = CAP_TIERS.reduce((best, t, i) => (t <= perCard * 3 ? i : best), 0);
      const nonGcCad = (d) => {
        const each = (c) => (c.game_changer ? 0 : (cardPrices(c)[0] || { usd: 0.5 }).usd * budgetFx.rate);
        return each(d.commander) + d.groups.reduce((s, g) => s + g.cards.reduce((t, c) => t + each(c) * (c.qty || 1), 0), 0);
      };
      const fits = (d) => nonGcCad(d) <= budget;
      await setStatus("Fitting the budget...");
      deck = await assembleForBracket(CAP_TIERS[tier]);
      if (fits(deck)) {
        for (let up = 0; up < 2 && tier < CAP_TIERS.length - 1; up++) {
          const looser = await assembleForBracket(CAP_TIERS[tier + 1]);
          if (!fits(looser)) break;
          deck = looser;
          tier++;
        }
      } else {
        for (let down = 0; down < 4 && tier > 0 && !fits(deck); down++) {
          tier--;
          deck = await assembleForBracket(CAP_TIERS[tier]);
        }
      }
    } else {
      deck = await assembleForBracket(Infinity);
    }

    // Two-card combos can't be ruled out card by card, so check the finished deck and swap
    // a piece of any combo the target doesn't allow.
    let fix = null;
    if (bracketTarget < 4) {
      await setStatus("Checking for two-card combos...");
      currentDeck = deck;
      fix = await runAdjustment(deck, bracketTarget);
    }

    // Trim to the budget last. The target bracket is a floor: if the deck reads lower than the
    // target already, that lower reading is the floor, and it is never taken below either.
    let budgetResult = null;
    if (budget) {
      await setStatus("Trimming to the budget...");
      currentDeck = deck;
      const floor = Math.min(bracketTarget, estimateBracket(deck, knownComboInfo(deck)).bracket);
      budgetResult = await runBudgetAdjustment(deck, budget, floor, (text) => {
        el("status-text").textContent = text;
      });
    }

    currentDeck = deck;
    renderDeck(deck);
    if (fix) showAdjustResult(deck, bracketTarget, fix.swaps, fix.stuck, fix.comboChecked, fix.failed, true);
    if (budgetResult) {
      budgetInput.value = String(budget);
      refreshBudgetControls();
      showBudgetResult(budgetResult, true);
    }
  } catch (err) {
    el("status-text").textContent = "Something went wrong: " + err.message;
    console.error(err);
    return;
  } finally {
    el("build-btn").disabled = false;
    el("status-panel").classList.add("hidden");
  }
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

// EDHREC's theme pages are scoped to the commander already, but this is a cheap
// extra guarantee that nothing off-color slips into the deck from that pool.
function isColorLegal(card, identity) {
  const cardColors = card.color_identity || [];
  if (!identity.length) return cardColors.length === 0;
  return cardColors.every((c) => identity.includes(c));
}

// Fetch lands (Polluted Delta, etc.) have no mana symbols in their text, so Scryfall
// gives them an empty color identity and they'd otherwise slip into any deck. Only
// keep them when the basic land type(s) they search for are actually in-color.
const BASIC_TYPE_COLOR = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };
function isLandRelevant(card, identity) {
  const text = card.oracle_text || (card.card_faces ? card.card_faces.map((f) => f.oracle_text || "").join(" ") : "") || "";
  const mentioned = Object.keys(BASIC_TYPE_COLOR).filter((t) => new RegExp(t, "i").test(text));
  if (!mentioned.length) return true; // not a basic-land-fetching effect, keep it
  if (!identity.length) return false; // colorless deck: any basic-type fetch is dead weight
  return mentioned.some((t) => identity.includes(BASIC_TYPE_COLOR[t]));
}

function buildBasicLands(identity, sampleCards, count) {
  if (count <= 0) return { entries: [] };
  const colors = identity.length ? identity : [];
  if (!colors.length) {
    return { entries: [{ name: "Wastes", qty: count, isBasic: true }] };
  }
  if (colors.length === 1) {
    return { entries: [{ name: BASIC_LAND_NAME[colors[0]], qty: count, isBasic: true }] };
  }

  const pipCounts = Object.fromEntries(colors.map((c) => [c, 0]));
  for (const card of sampleCards) {
    const cost = cardManaCost(card);
    for (const c of colors) {
      const matches = cost.match(new RegExp(`\\{[^}]*${c}[^}]*\\}`, "g"));
      if (matches) pipCounts[c] += matches.length;
    }
  }

  const totalPips = colors.reduce((s, c) => s + pipCounts[c], 0);
  const raw = {};
  if (totalPips === 0) {
    colors.forEach((c) => (raw[c] = count / colors.length));
  } else {
    colors.forEach((c) => (raw[c] = (pipCounts[c] / totalPips) * count));
  }

  // Largest-remainder rounding so totals add up exactly, with a floor of 1 per color.
  const floors = {};
  let allocated = 0;
  colors.forEach((c) => {
    floors[c] = Math.max(1, Math.floor(raw[c]));
    allocated += floors[c];
  });
  let remainder = count - allocated;
  const byFrac = [...colors].sort((a, b) => (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a])));
  let i = 0;
  while (remainder > 0) {
    floors[byFrac[i % byFrac.length]] += 1;
    remainder--;
    i++;
  }
  while (remainder < 0) {
    const c = [...colors].sort((a, b) => floors[b] - floors[a])[0];
    if (floors[c] > 1) floors[c] -= 1;
    remainder++;
  }

  const entries = colors
    .filter((c) => floors[c] > 0)
    .map((c) => ({ name: BASIC_LAND_NAME[c], qty: floors[c], isBasic: true }));
  return { entries };
}

// ---------- Rendering ----------

// Ordered so a card lands in the first bucket that applies — a Creature that's also
// an Artifact shows under Creatures, matching how most deckbuilding sites group by type.
const TYPE_CATEGORY_ORDER = [
  ["Creatures", /Creature/],
  ["Planeswalkers", /Planeswalker/],
  ["Battles", /Battle/],
  ["Instants", /Instant/],
  ["Sorceries", /Sorcery/],
  ["Artifacts", /Artifact/],
  ["Enchantments", /Enchantment/],
  ["Lands", /Land/],
];
function cardTypeCategory(card) {
  const typeLine = card.type_line || "";
  for (const [name, pattern] of TYPE_CATEGORY_ORDER) {
    if (pattern.test(typeLine)) return name;
  }
  return "Other";
}

// Builds the groups actually rendered, without touching deck.groups itself (the real
// data model add/remove operate on). Each entry keeps a pointer back to its true
// {group, index} in deck.groups so removal works correctly regardless of display mode.
function getDisplayGroups(deck, mode) {
  if (mode === "type") {
    const buckets = new Map();
    deck.groups.forEach((group) => {
      group.cards.forEach((card, index) => {
        const cat = cardTypeCategory(card);
        if (!buckets.has(cat)) buckets.set(cat, []);
        buckets.get(cat).push({ card, qty: card.qty || 1, group, index });
      });
    });
    const order = [...TYPE_CATEGORY_ORDER.map((t) => t[0]), "Other"];
    return order.filter((name) => buckets.has(name)).map((name) => ({ name, entries: buckets.get(name) }));
  }
  return deck.groups.map((group) => ({
    name: group.name,
    entries: group.cards.map((card, index) => ({ card, qty: card.qty || 1, group, index })),
  }));
}

function renderDeck(deck) {
  const totalCards = 1 + deck.groups.reduce((sum, g) => sum + g.cards.reduce((s, c) => s + (c.qty || 1), 0), 0);
  el("deck-count").textContent = `(${totalCards} cards)`;
  el("deck-archetype-label").textContent = deck.archetypeLabel
    ? `Archetype: ${deck.archetypeLabel}${deck.synergyNote ? " — " + deck.synergyNote : ""}`
    : "";

  const groupsEl = el("deck-groups");
  groupsEl.innerHTML = "";

  const commanderGroup = document.createElement("div");
  commanderGroup.className = "deck-group";
  commanderGroup.innerHTML = `<h3><span>Commander</span></h3>`;
  const cGrid = document.createElement("div");
  cGrid.className = "card-grid";
  cGrid.appendChild(cardTile(deck.commander, 1));
  commanderGroup.appendChild(cGrid);
  groupsEl.appendChild(commanderGroup);

  for (const dg of getDisplayGroups(deck, viewMode)) {
    if (!dg.entries.length) continue;
    const count = dg.entries.reduce((s, e) => s + e.qty, 0);
    const wrap = document.createElement("div");
    wrap.className = "deck-group";
    wrap.innerHTML = `<h3><span>${escapeHtml(dg.name)}</span><span class="group-meta"><span class="group-value"></span><span>${count}</span></span></h3>`;
    fillGroupValue(wrap.querySelector(".group-value"), dg.entries);
    const grid = document.createElement("div");
    grid.className = "card-grid";
    dg.entries.forEach((entry) => {
      const tile = cardTile(entry.card, entry.qty, { group: entry.group, index: entry.index });
      makeRemovable(tile, entry.group, entry.index);
      grid.appendChild(tile);
    });
    wrap.appendChild(grid);
    groupsEl.appendChild(wrap);
  }

  renderCurve(deck);

  el("deck-panel").classList.remove("hidden");
  currentDeck = deck;
  updateBracket(deck);
  updateDeckValue(deck);
}

// The whole deck's estimated value: each card's price (the one shown under it) times how many
// copies it has, added up. Cards with no price at all are left out and counted separately.
let deckValueToken = 0; // a slow lookup notices the deck changed again and steps aside
let deckTotal = null; // { deck, total, fx } once the current deck is fully priced; the budget controls read it
async function fillGroupValue(target, entries) {
  const [fx, infos] = await Promise.all([fetchUsdToCad(), Promise.all(entries.map((e) => resolveCardPrice(e.card)))]);
  let total = 0;
  entries.forEach((e, i) => {
    if (infos[i]) total += unitAmount(infos[i].main.usd, fx) * e.qty;
  });
  target.textContent = `${fx ? "≈ " : ""}${formatAmount(total, fx)}`;
}

async function updateDeckValue(deck) {
  const token = ++deckValueToken;
  deckTotal = null;
  refreshBudgetControls();
  const box = el("deck-value");
  if (!box.textContent) box.textContent = "Estimating value…";

  const entries = [deck.commander, ...deck.groups.flatMap((g) => g.cards)].map((card) => ({ card, qty: card.qty || 1 }));
  const fx = await fetchUsdToCad();
  if (token !== deckValueToken) return;

  // Add up the amounts as they're shown on the tiles (whole cents), so the numbers agree.
  const each = (usd) => unitAmount(usd, fx);
  const show = (total, noteText) => {
    const amount = document.createElement("strong");
    amount.textContent = `${fx ? "≈ " : ""}${formatAmount(total, fx)}`;
    const note = document.createElement("span");
    note.className = "deck-value-note";
    note.textContent = noteText;
    box.replaceChildren("Estimated value: ", amount, note);
  };

  // Cards whose shown printing has a price count straight away; the rest need a lookup for a
  // cheaper printing, which can take several seconds, so show what we have meanwhile.
  let quick = 0;
  let waiting = 0;
  entries.forEach((e) => {
    const prices = cardPrices(e.card);
    if (prices.length) quick += each(prices[0].usd) * e.qty;
    else waiting += e.qty;
  });
  if (waiting) show(quick, ` so far, still pricing ${plural(waiting, ["card", "cards"])}…`);

  const infos = await Promise.all(entries.map((e) => resolveCardPrice(e.card)));
  if (token !== deckValueToken) return;
  let total = 0;
  let unpriced = 0;
  entries.forEach((e, i) => {
    if (infos[i]) total += each(infos[i].main.usd) * e.qty;
    else unpriced += e.qty;
  });
  show(total, unpriced ? ` ${plural(unpriced, ["card has", "cards have"])} no price and ${unpriced === 1 ? "isn't" : "aren't"} counted.` : "");
  deckTotal = { deck, total, fx };
  refreshBudgetControls();
}

// Renders an actual card image (not a text row) for every card, including basic lands
// once their art has been fetched in buildDeck's balancing step. `ctx` ({group, index}) says
// where a deck card lives so the details window can offer to swap it; it's left out for the
// commander and for search results.
let suppressClickUntil = 0; // a touch drag can end with a stray click on the tile; ignore it
function cardTile(card, qty, ctx) {
  const tile = document.createElement("div");
  tile.className = "card-tile";
  tile.title = card.name;
  const art = cardArt(card, "normal") || cardArt(card, "small");
  if (art) {
    const img = document.createElement("img");
    img.src = art;
    img.alt = card.name;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(missingArtLabel(card.name));
    });
    tile.appendChild(img);
  } else {
    tile.appendChild(missingArtLabel(card.name));
  }
  const price = document.createElement("div");
  price.className = "card-price";
  tile.appendChild(price);
  fillCardPrice(price, card, qty);
  if (qty > 1) {
    const badge = document.createElement("span");
    badge.className = "qty-badge";
    badge.textContent = `×${qty}`;
    tile.appendChild(badge);
  }
  if (card.game_changer) tile.appendChild(gameChangerBadge());
  tile.addEventListener("click", () => {
    if (Date.now() < suppressClickUntil) return;
    openCardModal(card, ctx);
  });
  return tile;
}

function missingArtLabel(name) {
  const label = document.createElement("div");
  label.className = "art-missing";
  label.textContent = name;
  return label;
}

// ---------- Card details window: big card + Rulings / Combos / Replacements tabs ----------
//
// Clicking any card opens this on top of the page, dimming (not hiding) the deck behind it.

const modalEl = el("card-modal");
const modalPanelEl = el("modal-panel");
let modalState = null; // { card, ctx, tab, token, opener } while open
let modalToken = 0; // lets slow lookups notice the window has moved on to another card or tab

const modalNote = (text) => `<p class="modal-note">${escapeHtml(text)}</p>`;

function openCardModal(card, ctx) {
  const art = cardArt(card, "large") || cardArt(card, "normal") || cardArt(card, "small");
  const isBasic = /Basic Land/.test(card.type_line || "");
  const canReplace = !!ctx && !isBasic && !ctx.group.isBasics && ctx.group.cards[ctx.index] === card;
  const isCommander = !!currentDeck && card.id === currentDeck.commander.id;

  modalState = { card, ctx, canReplace, tab: "rulings", token: ++modalToken, opener: document.activeElement };

  const img = el("modal-img");
  img.classList.toggle("hidden", !art);
  img.src = art || "";
  img.alt = card.name;
  el("modal-title").textContent = card.name;
  el("modal-sub").textContent = [card.type_line, isCommander ? "Commander" : ctx && ctx.group.name].filter(Boolean).join(" · ");
  el("modal-gc").classList.toggle("hidden", !card.game_changer);
  modalEl.querySelector('[data-tab="combos"]').classList.toggle("hidden", !combosApply(card));
  modalEl.querySelector('[data-tab="replacements"]').classList.toggle("hidden", !canReplace);

  modalEl.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  showModalTab("rulings");
  renderPrice(card, modalState.token);
  el("modal-close").focus();
}

function closeCardModal() {
  if (!modalState) return;
  const opener = modalState.opener;
  modalState = null;
  modalToken++;
  modalEl.classList.add("hidden");
  document.body.style.overflow = "";
  if (opener && document.contains(opener)) opener.focus();
}

function showModalTab(tab) {
  if (!modalState) return;
  modalState.tab = tab;
  const { card, ctx, token } = modalState;
  const live = () => modalState && modalState.token === token && modalState.tab === tab;

  modalEl.querySelectorAll(".modal-tab").forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  modalPanelEl.scrollTop = 0;

  if (tab === "rulings") {
    modalPanelEl.innerHTML = modalNote("Loading rulings…");
    fetchRulings(card).then((rulings) => live() && renderRulings(rulings));
  } else if (tab === "combos") {
    modalPanelEl.innerHTML = modalNote("Checking combos…");
    fetchCombos(card).then((combos) => live() && renderCombos(combos, card));
  } else {
    modalPanelEl.innerHTML = modalNote("Finding replacements…");
    fetchReplacements(card, ctx).then((result) => live() && renderReplacements(result, card, ctx));
  }
}

modalEl.addEventListener("click", (e) => {
  if (e.target === modalEl) closeCardModal(); // a click on the dimmed area outside the window
});
el("modal-close").addEventListener("click", closeCardModal);
modalEl.querySelectorAll(".modal-tab").forEach((b) => b.addEventListener("click", () => showModalTab(b.dataset.tab)));
document.addEventListener("keydown", (e) => {
  if (!modalState) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeCardModal();
  } else if (e.key === "Tab") {
    // Keep keyboard focus inside the window while it's open.
    const focusable = [...modalEl.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modalEl.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// ---------- Estimated price ----------
//
// Scryfall gives every card a USD price (from TCGplayer). We convert that to CAD with the
// day's exchange rate, so it's an estimate: Canadian shops usually charge more than a straight
// conversion. If the rate can't be loaded, the USD price is shown on its own.

const modalPriceEl = el("modal-price");
let usdToCadPromise = null; // { rate, date } | null

function fetchUsdToCad() {
  if (!usdToCadPromise) {
    const promise = (async () => {
      try {
        const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD");
        if (!res.ok) return null;
        const data = await res.json();
        const rate = data.rates && data.rates.CAD;
        return typeof rate === "number" && rate > 0 ? { rate, date: String(data.date || "") } : null;
      } catch {
        return null;
      }
    })();
    usdToCadPromise = promise;
    promise.then((result) => {
      if (result === null && usdToCadPromise === promise) usdToCadPromise = null; // retry next time
    });
  }
  return usdToCadPromise;
}

// Regular price first; foil and etched only when the card has them. Cards that only exist
// as foil have no regular price, so their foil price leads instead.
function cardPrices(card) {
  const p = card.prices || {};
  return [
    { label: "", usd: parseFloat(p.usd) },
    { label: "foil", usd: parseFloat(p.usd_foil) },
    { label: "etched", usd: parseFloat(p.usd_etched) },
  ].filter((x) => Number.isFinite(x.usd) && x.usd > 0);
}

// The printing shown can lack a price (for example one from a set that hasn't released yet),
// so fall back to the cheapest printing that has one, and say so.
const cheapestPrintingCache = new Map(); // oracle id -> Promise<card | null>
function fetchCheapestPrinting(card) {
  if (!card.oracle_id) return Promise.resolve(null);
  if (!cheapestPrintingCache.has(card.oracle_id)) {
    const promise = (async () => {
      const q = encodeURIComponent(`oracleid:${card.oracle_id} game:paper usd>0`);
      try {
        const res = await fetch(`${SCRYFALL}/cards/search?q=${q}&unique=prints&order=usd&dir=asc`);
        if (res.status === 404) return null; // no printing has a price
        if (!res.ok) throw new Error(`Scryfall ${res.status}`);
        const data = await res.json();
        return (data.data && data.data[0]) || null;
      } catch {
        cheapestPrintingCache.delete(card.oracle_id); // retry next time
        return null;
      }
    })();
    cheapestPrintingCache.set(card.oracle_id, promise);
  }
  return cheapestPrintingCache.get(card.oracle_id);
}

// Fallback lookups start a beat apart and at most four run at once, so a deck with a dozen
// unpriced cards is done in a few seconds without hitting Scryfall with a burst of requests.
const cheapestQueue = [];
let cheapestActive = 0;
let cheapestLastStart = 0;
function pumpCheapest() {
  while (cheapestActive < 4 && cheapestQueue.length) {
    const wait = cheapestLastStart + 110 - Date.now();
    if (wait > 0) {
      setTimeout(pumpCheapest, wait);
      return;
    }
    const { card, resolve } = cheapestQueue.shift();
    cheapestActive++;
    cheapestLastStart = Date.now();
    fetchCheapestPrinting(card).then(resolve).finally(() => {
      cheapestActive--;
      pumpCheapest();
    });
  }
}
function fetchCheapestPrintingQueued(card) {
  if (!card.oracle_id || cheapestPrintingCache.has(card.oracle_id)) return fetchCheapestPrinting(card);
  return new Promise((resolve) => {
    cheapestQueue.push({ card, resolve });
    pumpCheapest();
  });
}

// The price shown for a card everywhere (under its tile, in the details window and in the
// deck total): { main, others, fallbackSet } or null when no printing has a price.
const priceCache = new Map(); // card id (or name) -> Promise<info | null>
function resolveCardPrice(card) {
  const key = card.id || card.name;
  if (!priceCache.has(key)) {
    const promise = (async () => {
      let prices = cardPrices(card);
      let fallbackSet = null;
      if (!prices.length) {
        const cheapest = await fetchCheapestPrintingQueued(card);
        if (!cheapest) return null;
        prices = cardPrices(cheapest);
        fallbackSet = cheapest.set_name;
      }
      return prices.length ? { main: prices[0], others: prices.slice(1), fallbackSet } : null;
    })();
    priceCache.set(key, promise);
    promise.then((info) => {
      if (!info) priceCache.delete(key); // maybe a failed lookup; try again next time
    });
  }
  return priceCache.get(key);
}

// `amount` is already in the shown currency: CAD when there's an exchange rate, otherwise USD.
const cents = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const formatAmount = (amount, fx) =>
  fx ? `$${amount.toLocaleString("en-CA", cents)} CAD` : `US$${amount.toLocaleString("en-US", cents)}`;
const formatMoney = (usd, fx) => formatAmount(fx ? usd * fx.rate : usd, fx);
// A card's price in whole cents of the shown currency, the way it's displayed and added up.
const unitAmount = (usd, fx) => (fx ? Math.round(usd * fx.rate * 100) / 100 : usd);
const priceText = (main, fx) => `${fx ? "≈ " : ""}${formatMoney(main.usd, fx)}${main.label ? ` (${main.label})` : ""}`;

// Fills an element with a card's price, the same text as at the top of its details window.
async function fillCardPrice(target, card, qty = 1) {
  const [info, fx] = await Promise.all([resolveCardPrice(card), fetchUsdToCad()]);
  if (!info) {
    target.textContent = "No price";
    target.classList.add("none");
    return;
  }
  target.textContent = priceText(info.main, fx) + (qty > 1 ? " ea" : "");
  target.classList.remove("none");
}

async function renderPrice(card, token) {
  modalPriceEl.classList.add("hidden");
  modalPriceEl.textContent = "";
  const stale = () => !modalState || modalState.token !== token; // window moved on while we waited

  const info = await resolveCardPrice(card);
  if (stale() || !info) return;

  const fx = await fetchUsdToCad();
  if (stale()) return;

  const { main, others, fallbackSet } = info;
  const usd = (n) => `US$${n.toFixed(2)}`;
  const show = (p) => formatMoney(p.usd, fx);

  const line = document.createElement("div");
  line.className = "price-line";
  const mainEl = document.createElement("span");
  mainEl.className = "price-main";
  mainEl.textContent = priceText(main, fx);
  line.appendChild(mainEl);
  others.forEach((p) => {
    const alt = document.createElement("span");
    alt.className = "price-alt";
    alt.textContent = `${p.label} ${fx ? "≈ " : ""}${show(p)}`;
    line.appendChild(alt);
  });

  const note = document.createElement("div");
  note.className = "price-note";
  const lead = fallbackSet ? `No price yet for this printing, so this uses the cheapest printing (${fallbackSet}): ` : "";
  const source = `${usd(main.usd)} on Scryfall / TCGplayer`;
  note.textContent = fx
    ? `${lead || "Estimated from "}${source}, at 1 USD = ${fx.rate.toFixed(3)} CAD${fx.date ? ` (rates of ${fx.date})` : ""}. Canadian stores usually charge more.`
    : `${lead}${source}. The CAD conversion isn't available right now.`;

  modalPriceEl.replaceChildren(line, note);
  modalPriceEl.classList.remove("hidden");
}

// ---------- Replacements ----------
//
// Suggests other popular cards for the same job as the one you clicked, using the same
// searches that built the deck: the role tag for ramp/removal/wipes/draw, land search for
// lands, and otherwise the same card type at a similar mana cost. Cards already in the deck
// are left out, and "Swap in" puts the new card exactly where the old one was.

const ROLE_TAG = { Ramp: "otag:ramp", Removal: "otag:removal", "Board Wipes": "otag:board-wipe", "Card Draw": "otag:card-advantage" };
const TYPE_QUERY = {
  Creatures: "t:creature",
  Planeswalkers: "t:planeswalker",
  Battles: "t:battle",
  Instants: "t:instant",
  Sorceries: "t:sorcery",
  Artifacts: "t:artifact -t:creature",
  Enchantments: "t:enchantment -t:creature",
};

function replacementSearch(card, ctx) {
  const idFrag = identityQueryFragment(currentDeck.identity);
  const base = `${idFrag} legal:commander -is:commander game:paper`;
  const role = ctx.group.name;
  if (ROLE_TAG[role]) return { query: `${base} ${ROLE_TAG[role]} order:edhrec`, label: role.toLowerCase() };

  const category = cardTypeCategory(card);
  if (role === "Nonbasic Lands" || category === "Lands") {
    return { query: `${idFrag} legal:commander t:land -t:basic game:paper order:edhrec`, label: "lands", landsOnly: true };
  }
  if (!TYPE_QUERY[category]) return null;
  const cmc = Math.floor(cardCmc(card));
  return {
    query: `${base} ${TYPE_QUERY[category]} cmc>=${Math.max(0, cmc - 1)} cmc<=${cmc + 1} order:edhrec`,
    label: `${category.toLowerCase()} at a similar cost`,
  };
}

const replacementCache = new Map(); // search query -> Promise<card[] | null>
function searchPool(query) {
  if (!replacementCache.has(query)) {
    const promise = scryfallSearch(query, { limit: 60 }).catch(() => null);
    replacementCache.set(query, promise);
    promise.then((pool) => {
      if (pool === null) replacementCache.delete(query); // don't remember failures
    });
  }
  return replacementCache.get(query);
}

function fetchReplacements(card, ctx) {
  const search = replacementSearch(card, ctx);
  if (!search) return Promise.resolve({ label: "", cards: [] });
  return searchPool(search.query).then((pool) => {
    if (pool === null) return null;
    // Filtered fresh each time, so the list reflects the deck as it is right now.
    const usable = pool.filter(
      (c) => !deckHasCard(currentDeck, c.name) && (!search.landsOnly || isLandRelevant(c, currentDeck.identity))
    );
    return { label: search.label, cards: usable.slice(0, 8) };
  });
}

function renderReplacements(result, card, ctx) {
  if (result === null) {
    modalPanelEl.innerHTML = modalNote("Couldn't load replacement ideas right now.");
    return;
  }
  if (!result.cards.length) {
    modalPanelEl.innerHTML = modalNote("No other suggestions found for this card's role.");
    return;
  }
  modalPanelEl.innerHTML = modalNote(`Other popular ${result.label} not in your deck yet. Swapping puts the new card where ${card.name} is now.`);
  const grid = document.createElement("div");
  grid.className = "suggestion-grid";
  result.cards.forEach((c) => {
    const item = document.createElement("div");
    item.className = "suggestion";
    const art = cardArt(c, "normal") || cardArt(c, "small");
    if (art) {
      const img = document.createElement("img");
      img.src = art;
      img.alt = c.name;
      item.appendChild(img);
    } else {
      item.appendChild(missingArtLabel(c.name));
    }
    const name = document.createElement("div");
    name.className = "suggestion-name";
    name.textContent = c.name;
    if (c.game_changer) name.appendChild(gameChangerBadge());
    const price = document.createElement("div");
    price.className = "card-price";
    fillCardPrice(price, c);
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "secondary swap-btn";
    swap.textContent = "Swap in";
    swap.setAttribute("aria-label", `Swap ${card.name} for ${c.name}`);
    swap.addEventListener("click", () => swapCard(ctx, card, c));
    item.append(name, price, swap);
    grid.appendChild(item);
  });
  modalPanelEl.appendChild(grid);
}

function swapCard(ctx, oldCard, newCard) {
  if (!currentDeck || ctx.group.cards[ctx.index] !== oldCard) {
    showToast("The deck changed — close this window and try again.");
    return;
  }
  if (deckHasCard(currentDeck, newCard.name)) {
    showToast(`${newCard.name} is already in the deck.`);
    return;
  }
  ctx.group.cards[ctx.index] = newCard;
  closeCardModal();
  showToast(`Swapped ${oldCard.name} for ${newCard.name}.`);
  renderDeck(currentDeck);
}

// ---------- Combos (Commander Spellbook, via our own /api/proxy) ----------
//
// Commander Spellbook blocks direct browser requests, so the lookup goes through the
// serverless function in api/proxy.js. Where that function isn't available (for example
// on a plain static file server), fetchCombos resolves to null and the Combos tab says
// so — nothing else on the page depends on it.

const comboCache = new Map(); // "card|colors" -> Promise<combo[] | null>

// Spellbook lists double-faced cards by their full "A // B" name; we match on the front face.
function frontFace(name) {
  return name.split(" // ")[0];
}

function combosApply(card) {
  return !!currentDeck && !/Basic Land/.test(card.type_line || "");
}

function fetchCombos(card) {
  const colors = (currentDeck.identity || []).join("");
  const name = frontFace(card.name);
  const key = `${name}|${colors}`;
  if (!comboCache.has(key)) {
    const promise = (async () => {
      try {
        const res = await fetch(`/api/proxy?target=spellbook&card=${encodeURIComponent(name)}&ci=${colors}`);
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data.combos) ? data.combos : null;
      } catch {
        return null;
      }
    })();
    comboCache.set(key, promise);
    promise.then((result) => {
      if (result === null) comboCache.delete(key); // don't remember failures; retry next time
    });
  }
  return comboCache.get(key);
}

// The fetched combos are cached per card, but which of them are complete is worked out
// fresh each time the tab is shown, so it always reflects the deck as it is right now.
function classifyCombos(combos, card) {
  const have = new Set([frontFace(currentDeck.commander.name).toLowerCase(), frontFace(card.name).toLowerCase()]);
  currentDeck.groups.forEach((g) => g.cards.forEach((c) => have.add(frontFace(c.name).toLowerCase())));

  const complete = [];
  const near = [];
  for (const combo of combos) {
    const missing = combo.cards.filter((n) => !have.has(frontFace(n).toLowerCase()));
    if (missing.length === 0) complete.push(combo);
    else if (missing.length === 1) near.push({ ...combo, missing: missing[0] });
  }
  return { complete: complete.slice(0, 6), near: near.slice(0, 6) };
}

function comboHtml(combo, missing) {
  const extra = combo.produces.length - 3;
  const result = combo.produces.slice(0, 3).join(", ") + (extra > 0 ? ` +${extra} more` : "");
  return `<div class="combo ${missing ? "combo-near" : "combo-complete"}">
    <span class="combo-tag">${missing ? `Missing ${escapeHtml(missing)}` : "Complete"}</span>
    <div class="combo-cards">${combo.cards.map(escapeHtml).join(" + ")}</div>
    ${result ? `<div class="combo-result">${escapeHtml(result)}</div>` : ""}
  </div>`;
}

function renderCombos(combos, card) {
  if (combos === null) {
    modalPanelEl.innerHTML = modalNote("Combo lookup isn't available right now.");
    return;
  }
  const { complete, near } = classifyCombos(combos, card);
  if (!complete.length && !near.length) {
    modalPanelEl.innerHTML = modalNote("No combos using this card with your current deck.");
    return;
  }
  modalPanelEl.innerHTML = complete.map((c) => comboHtml(c, null)).join("") + near.map((c) => comboHtml(c, c.missing)).join("");
}

// ---------- Game Changers and the estimated bracket ----------
//
// Wizards' Commander Brackets (1 Exhibition ... 5 cEDH) come down to a few things you can check
// from a decklist: how many "Game Changers" it runs (Scryfall flags each one as
// card.game_changer), mass land denial, extra turns, and two-card combos. Brackets 1-2 allow no
// Game Changers, 3 allows up to three, and 4-5 allow any number. Mass land denial and chained
// extra turns start at 4, and 3 only allows two-card combos that come late. This is a guide,
// not a verdict: it can't tell 1 from 2 (theme decks), or 4 from 5 (a competitive metagame).

const BRACKET_NAMES = { 2: "Core", 3: "Upgraded", 4: "Optimized" };
const COMBO_TAG_LABEL = { R: "Ruthless", S: "Spicy", P: "Powerful" }; // Spellbook's ratings that count

// Cards that destroy or exile lots of lands at once (front-face names, lowercase).
const MASS_LAND_DENIAL = new Set([
  "armageddon", "ravages of war", "catastrophe", "devastation", "jokulhaups", "obliterate",
  "decree of annihilation", "ruination", "sunder", "death cloud", "apocalypse", "boom",
  "impending disaster", "cataclysm", "tectonic break", "global ruin", "acid rain", "boiling seas",
  "fall of the thran", "realm razer", "restore balance", "thoughts of ruin", "tsunami",
  "wake of destruction", "burning of xinye", "numot, the devastator",
]);

function gameChangerBadge() {
  const badge = document.createElement("span");
  badge.className = "gc-badge";
  badge.textContent = "GC";
  badge.title = "Game Changer";
  return badge;
}

const oracleTextOf = (card) => card.oracle_text || (card.card_faces || []).map((f) => f.oracle_text || "").join(" ");
const isExtraTurnCard = (card) => /\bextra turns?\b/i.test(oracleTextOf(card));

// `comboInfo` is {status: "pending" | "unavailable"} or {status: "ok", combos} from Spellbook.
function estimateBracket(deck, comboInfo) {
  const cards = [deck.commander, ...deck.groups.flatMap((g) => g.cards)];
  const namesOf = (list) => list.map((c) => c.name);
  const gameChangers = namesOf(cards.filter((c) => c.game_changer));
  const landDenial = namesOf(cards.filter((c) => MASS_LAND_DENIAL.has(frontFace(c.name).toLowerCase())));
  const extraTurns = namesOf(cards.filter(isExtraTurnCard));
  // Only combos whose pieces are all still in the deck count (that matters when a swap is being
  // tried out before it's made).
  const have = new Set(cards.map((c) => frontFace(c.name).toLowerCase()));
  const combos = comboInfo.status === "ok"
    ? comboInfo.combos.filter(
        (c) => c.cards.length === 2 && COMBO_TAG_LABEL[c.bracketTag] && c.cards.every((n) => have.has(frontFace(n).toLowerCase()))
      )
    : [];
  const earlyCombos = combos.filter((c) => c.bracketTag === "R");
  const comboText = (list) => list.map((c) => c.cards.join(" + ")).join("; ");

  let bracket = 2;
  const why = [];
  const need = (b, text) => {
    bracket = Math.max(bracket, b);
    why.push({ b, text });
  };
  if (gameChangers.length > 3) need(4, `${gameChangers.length} Game Changers (Bracket 3 allows up to 3)`);
  else if (gameChangers.length) need(3, `${gameChangers.length} Game Changer${gameChangers.length > 1 ? "s" : ""} (Brackets 1–2 allow none)`);
  if (landDenial.length) need(4, `mass land denial (${landDenial.join(", ")})`);
  if (extraTurns.length >= 3) need(4, `${extraTurns.length} extra-turn spells that could be chained`);
  if (earlyCombos.length) need(4, `a fast two-card combo (${comboText(earlyCombos)})`);
  else if (combos.length) need(3, `a two-card combo (${comboText(combos)}); only late-game ones fit Bracket 3`);
  why.sort((a, b) => b.b - a.b);

  return { bracket, why, gameChangers, landDenial, extraTurns, combos };
}

function renderBracket(deck, comboInfo) {
  const est = estimateBracket(deck, comboInfo);
  const list = (names) => names.map(escapeHtml).join(", ");
  const fact = (label, value, level) =>
    `<li class="fact-${level}"><b>${label}</b><span class="fact-value">${value}</span></li>`;

  const gcCount = est.gameChangers.length;
  const facts = [
    gcCount
      ? fact("Game Changers", `${gcCount}: ${list(est.gameChangers)}`, gcCount > 3 ? "hot" : "warn")
      : fact("Game Changers", "None", "ok"),
    est.landDenial.length ? fact("Mass land denial", list(est.landDenial), "hot") : fact("Mass land denial", "None", "ok"),
    est.extraTurns.length
      ? fact("Extra-turn spells", `${est.extraTurns.length}: ${list(est.extraTurns)}`, est.extraTurns.length >= 3 ? "hot" : "warn")
      : fact("Extra-turn spells", "None", "ok"),
  ];
  if (comboInfo.status === "ok") {
    facts.push(
      est.combos.length
        ? fact(
            "Two-card combos",
            est.combos.map((c) => `${c.cards.map(escapeHtml).join(" + ")} (${COMBO_TAG_LABEL[c.bracketTag]})`).join("<br>"),
            est.combos.some((c) => c.bracketTag === "R") ? "hot" : "warn"
          )
        : fact("Two-card combos", "None found", "ok")
    );
  } else {
    facts.push(
      fact("Two-card combos", comboInfo.status === "pending" ? "Checking…" : "Couldn't check right now", "warn")
    );
  }

  let hint = "";
  if (est.bracket === 2 && !est.why.length) hint = "A single Game Changer would make it Bracket 3.";
  else if (est.bracket === 3 && gcCount === 3 && est.why.every((w) => w.b < 4)) hint = "One more Game Changer would make it Bracket 4.";

  const reason = est.why.length
    ? `Because of ${est.why.map((w) => w.text).join("; ")}.`
    : "No Game Changers, mass land denial, chained extra turns or two-card combos found.";
  const unchecked = comboInfo.status !== "ok" && est.bracket < 4
    ? " Two-card combos aren't included yet."
    : "";

  el("bracket-summary").innerHTML = `
    <div class="bracket-head">
      <span class="bracket-badge bracket-${est.bracket}">Bracket ${est.bracket}</span>
      <span class="bracket-name">${BRACKET_NAMES[est.bracket]}</span>
      <span class="bracket-est">estimated</span>
    </div>
    <p class="bracket-why">${escapeHtml(reason + unchecked)}</p>
    ${hint ? `<p class="bracket-hint">${escapeHtml(hint)}</p>` : ""}
    <ul class="bracket-facts">${facts.join("")}</ul>
    <details class="bracket-more">
      <summary>How this is estimated</summary>
      <p>Based on Wizards of the Coast's Commander Brackets. Game Changers come from Scryfall's flag on each card. Extra-turn spells are found from card text and mass land denial from a list of known cards. Two-card combos come from Commander Spellbook: its Ruthless-rated combos are treated as fast (Bracket 4), and Spicy or Powerful ones as fine for Bracket 3. Bracket 1 is for themed or low-power decks and Bracket 5 is competitive (cEDH), so this only reports 2 to 4. Your pod's conversation matters more than any number here.</p>
    </details>`;
  el("bracket-panel").classList.remove("hidden");
  syncBracketControls(deck, est, comboInfo);
}

const bracketComboCache = new Map(); // deck key -> {status: "ok", combos}
let bracketToken = 0; // lets a slow combo lookup notice the deck has changed since
let bracketTimer = null;

function bracketDeckKey(deck) {
  const names = deck.groups.flatMap((g) => g.cards).filter((c) => !/Basic Land/.test(c.type_line || "")).map((c) => frontFace(c.name));
  return [frontFace(deck.commander.name), ...new Set(names)].sort().join("|");
}

// Shows the estimate right away from what's already known (Game Changers etc.), then adds the
// two-card combo check once Spellbook answers. Quick edits collapse into a single lookup.
function updateBracket(deck) {
  const token = ++bracketToken;
  clearTimeout(bracketTimer);
  const key = bracketDeckKey(deck);
  noteDeckForAdjust(deck, key);
  noteDeckForBudget(deck, key);
  const cached = bracketComboCache.get(key);
  renderBracket(deck, cached || { status: "pending" });
  if (cached) return;
  bracketTimer = setTimeout(async () => {
    const info = await fetchBracketCombos(deck, key);
    if (token === bracketToken) renderBracket(deck, info);
  }, 500);
}

async function fetchBracketCombos(deck, key) {
  const cards = [...new Set(deck.groups.flatMap((g) => g.cards).filter((c) => !/Basic Land/.test(c.type_line || "")).map((c) => frontFace(c.name)))];
  try {
    const res = await fetch("/api/proxy?target=spellbook-bracket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commander: frontFace(deck.commander.name), cards }),
    });
    if (!res.ok) return { status: "unavailable" };
    const data = await res.json();
    if (!Array.isArray(data.combos)) return { status: "unavailable" };
    const info = { status: "ok", combos: data.combos };
    bracketComboCache.set(key, info); // failures aren't remembered, so the next edit retries
    return info;
  } catch {
    return { status: "unavailable" };
  }
}

// ---------- Adjusting the deck toward a target bracket ----------
//
// The slider lowers the deck's bracket by swapping out the cards that raised it: Game Changers
// beyond what the target allows (the least popular go first, and cards you added yourself are
// kept longest), mass land denial, extra-turn spells beyond two, and one card from each
// two-card combo the target doesn't allow. Each card is replaced in place with a popular card
// for the same job that has none of those problems, so the deck stays at 100. Bracket 4 has no
// limits, so there is nothing to remove for it. Dragging the slider up instead brings Game
// Changers in (see runRaise).

const bracketSlider = el("bracket-slider");
const bracketApplyBtn = el("bracket-apply");
const bracketUndoBtn = el("bracket-undo");
const bracketNoteEl = el("bracket-target-note");
const bracketResultEl = el("bracket-result");

const REASON_LABEL = {
  gc: ["Game Changer", "Game Changers"],
  mld: ["mass land denial card", "mass land denial cards"],
  xt: ["extra-turn spell", "extra-turn spells"],
  combo: ["card from a two-card combo", "cards from two-card combos"],
  raise: ["Game Changer brought in", "Game Changers brought in"],
};
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

let sliderTouched = false; // false: the slider just follows the deck's current estimate
let adjustBusy = false;
let adjustDeck = null; // the deck the controls are currently about
let adjustView = null; // { deck, est, comboInfo } from the latest estimate
let undoState = null; // { deck, snapshot, key } while the last adjustment can be undone

// Which cards to swap out to reach `target`. `stuck` holds cards we already failed to replace.
function planAdjustment(deck, target, comboInfo, stuck = new Set()) {
  if (target >= 4) return [];
  const entries = deck.groups.flatMap((group) =>
    group.isBasics ? [] : group.cards.map((card, index) => ({ card, group, index }))
  );
  // Lower = keep longer: your own additions first, then the most popular cards.
  const keepScore = (e) => (e.group.isAdded ? 0 : 1e10) + (e.card.edhrec_rank ?? 1e9);
  const byKeep = (list) => [...list].sort((a, b) => keepScore(a) - keepScore(b));
  const nameOf = (e) => frontFace(e.card.name).toLowerCase();

  const chosen = new Map(); // entry -> reason
  const remove = (e, reason) => {
    if (!stuck.has(e.card.name) && !chosen.has(e)) chosen.set(e, reason);
  };

  entries.filter((e) => MASS_LAND_DENIAL.has(nameOf(e))).forEach((e) => remove(e, "mld"));
  byKeep(entries.filter((e) => isExtraTurnCard(e.card))).slice(2).forEach((e) => remove(e, "xt"));

  const allowed = (target === 2 ? 0 : 3) - (deck.commander.game_changer ? 1 : 0);
  byKeep(entries.filter((e) => e.card.game_changer)).slice(Math.max(0, allowed)).forEach((e) => remove(e, "gc"));

  if (comboInfo.status === "ok") {
    const banned = comboInfo.combos.filter(
      (c) => c.cards.length === 2 && (target === 2 ? COMBO_TAG_LABEL[c.bracketTag] : c.bracketTag === "R")
    );
    for (const combo of banned) {
      const pieces = combo.cards.map((n) => entries.find((e) => nameOf(e) === frontFace(n).toLowerCase())).filter(Boolean);
      if (!pieces.length || pieces.some((p) => chosen.has(p))) continue; // gone already, or the commander is one half
      const candidates = pieces.filter((p) => !stuck.has(p.card.name));
      if (candidates.length) remove(byKeep(candidates).pop(), "combo");
    }
  }
  return [...chosen].map(([e, reason]) => ({ ...e, reason }));
}

const describePlan = (plan) => {
  const counts = {};
  plan.forEach((p) => (counts[p.reason] = (counts[p.reason] || 0) + 1));
  return Object.keys(REASON_LABEL).filter((r) => counts[r]).map((r) => plural(counts[r], REASON_LABEL[r])).join(", ");
};

// A popular card for the same job, without the traits we're removing. Tries the same search the
// Replacements tab uses, then the same card type at any cost.
async function pickReplacement(deck, item, taken) {
  const usable = (c) =>
    !c.game_changer && !isExtraTurnCard(c) && !MASS_LAND_DENIAL.has(frontFace(c.name).toLowerCase()) &&
    !taken.has(c.name) && !deckHasCard(deck, c.name);
  const search = replacementSearch(item.card, { group: item.group, index: item.index });
  if (!search) return null;

  const queries = [{ query: `${search.query} -is:gamechanger`, landsOnly: !!search.landsOnly }];
  const category = cardTypeCategory(item.card);
  if (!search.landsOnly && TYPE_QUERY[category]) {
    const base = `${identityQueryFragment(deck.identity)} legal:commander -is:commander game:paper`;
    queries.push({ query: `${base} ${TYPE_QUERY[category]} -is:gamechanger order:edhrec`, landsOnly: false });
  }
  for (const q of queries) {
    const pool = await searchPool(q.query);
    const found = pool && pool.find((c) => usable(c) && (!q.landsOnly || isLandRelevant(c, deck.identity)));
    if (found) return found;
  }
  return null;
}

// Swaps out whatever keeps `deck` above `target`, in place. It needs currentDeck to be `deck`
// (the replacement searches read its colors). Returns what it did; the caller shows it.
async function runAdjustment(deck, target, onProgress = () => {}) {
  const swaps = [];
  const stuck = new Set(); // cards no replacement could be found for
  let comboChecked = true;
  let failed = false;
  try {
    // A few passes: a replacement can itself, rarely, complete a combo.
    for (let pass = 0; pass < 3; pass++) {
      const key = bracketDeckKey(deck);
      const info = bracketComboCache.get(key) || (await fetchBracketCombos(deck, key));
      if (info.status !== "ok") comboChecked = false;
      const plan = planAdjustment(deck, target, info, stuck);
      if (!plan.length) break;

      onProgress(`Replacing ${plural(plan.length, ["card", "cards"])}…`);
      const taken = new Set();
      let changed = 0;
      for (const item of plan) {
        if (item.group.cards[item.index] !== item.card) continue;
        const replacement = await pickReplacement(deck, item, taken);
        if (!replacement) {
          stuck.add(item.card.name);
          continue;
        }
        item.group.cards[item.index] = replacement;
        taken.add(replacement.name);
        swaps.push({ from: item.card, to: replacement, reason: item.reason });
        changed++;
      }
      if (!changed) break;
    }
  } catch {
    failed = true; // keep whatever was swapped so far, and say so
  }
  return { swaps, stuck: [...stuck], comboChecked, failed };
}

// Going up a bracket means bringing in Game Changers: enough to hold 3 for Bracket 3, or 6 for
// Bracket 4 (which starts at 4). The most popular ones for the deck's colors come first, each
// into the group that matches its job (Ramp, Removal, ...), taking the place of that group's
// least popular card. Anything without a matching group replaces the least popular flex card.
// Cards you added yourself and the basic lands are never touched.
const RAISE_GOAL = { 3: 3, 4: 6 };

async function runRaise(deck, target, onProgress = () => {}) {
  const swaps = [];
  let failed = false;
  const gcCount = () => [deck.commander, ...deck.groups.flatMap((g) => g.cards)].filter((c) => c.game_changer).length;
  const need = (RAISE_GOAL[target] || 0) - gcCount();
  if (need <= 0) return { swaps, stuck: [], comboChecked: true, failed };

  try {
    onProgress("Finding Game Changers…");
    const base = `${identityQueryFragment(deck.identity)} legal:commander -is:commander game:paper`;
    const pool = await searchPool(`${base} is:gamechanger order:edhrec`);
    if (!pool) throw new Error("Game Changer search failed");
    const usable = pool.filter(
      (c) =>
        !deckHasCard(deck, c.name) && !isExtraTurnCard(c) && !MASS_LAND_DENIAL.has(frontFace(c.name).toLowerCase()) &&
        isLandRelevant(c, deck.identity)
    );

    // Which group each Game Changer belongs in: the same role tags, limited to Game Changers.
    const roleOf = new Map();
    for (const [group, tag] of Object.entries(ROLE_TAG)) {
      const rolePool = await searchPool(`${base} ${tag} is:gamechanger order:edhrec`);
      (rolePool || []).forEach((c) => {
        if (!roleOf.has(c.name)) roleOf.set(c.name, group);
      });
    }

    // The cards each group could give up, least popular first.
    const leastPopular = (a, b) => (b.card.edhrec_rank ?? 1e9) - (a.card.edhrec_rank ?? 1e9);
    const slotsByGroup = new Map();
    const flex = []; // groups that aren't tied to a role
    deck.groups.forEach((group) => {
      if (group.isBasics || group.isAdded) return;
      const slots = group.cards.map((card, index) => ({ card, group, index })).filter((e) => !e.card.game_changer);
      slots.sort(leastPopular);
      slotsByGroup.set(group.name, slots);
      if (!ROLE_TAG[group.name] && group.name !== "Nonbasic Lands") flex.push(...slots);
    });
    flex.sort(leastPopular);
    const spent = new Set();
    const take = (slots) => {
      const slot = (slots || []).find((s) => !spent.has(s));
      if (slot) spent.add(slot);
      return slot;
    };

    let added = 0;
    for (const gc of usable) {
      if (added >= need) break;
      const isLand = /Land/.test(gc.type_line || "");
      const home = isLand ? "Nonbasic Lands" : roleOf.get(gc.name);
      const slot = take(slotsByGroup.get(home)) || (isLand ? null : take(flex));
      if (!slot) continue;
      slot.group.cards[slot.index] = gc;
      swaps.push({ from: slot.card, to: gc, reason: "raise" });
      added++;
    }
  } catch {
    failed = true;
  }
  return { swaps, stuck: [], comboChecked: true, failed };
}

async function adjustDeckToBracket(deck, target) {
  if (adjustBusy || budgetBusy || !deck) return;
  const raising = !!adjustView && target > adjustView.est.bracket;
  if (!raising && target >= 4) return;
  adjustBusy = true;
  clearAdjustResult();
  refreshAdjustControls();
  refreshBudgetControls();

  const snapshot = deck.groups.map((g) => g.cards.slice());
  const progress = (text) => {
    bracketNoteEl.textContent = text;
  };
  let result;
  if (raising) {
    result = await runRaise(deck, target, progress);
    if (target < 4) {
      // Bracket 3 still has limits (no fast combos and so on), and a new card might break one.
      const fix = await runAdjustment(deck, target, progress);
      result = {
        swaps: [...result.swaps, ...fix.swaps],
        stuck: fix.stuck,
        comboChecked: fix.comboChecked,
        failed: result.failed || fix.failed,
      };
    }
  } else {
    result = await runAdjustment(deck, target, progress);
  }
  const { swaps, stuck, comboChecked, failed } = result;

  adjustBusy = false;
  sliderTouched = false;
  bracketNoteEl.textContent = "";
  refreshBudgetControls();
  if (swaps.length) {
    undoState = { deck, snapshot, key: null };
    renderDeck(deck);
    undoState.key = bracketDeckKey(deck);
    bracketUndoBtn.classList.remove("hidden");
  } else {
    refreshAdjustControls();
  }
  showAdjustResult(deck, target, swaps, stuck, comboChecked, failed);
}

// `built` is for a deck that was just built for the target: any swaps here are the combo
// check that runs after the picks, not an adjustment the person asked for.
function showAdjustResult(deck, target, swaps, stuck, comboChecked, failed, built = false) {
  const est = adjustView && adjustView.est;
  const lines = [];
  if (built) {
    const fixed = swaps.length ? ` ${plural(swaps.length, ["card was", "cards were"])} then swapped to break up a two-card combo.` : "";
    lines.push(`<p>Built to fit Bracket ${target}.${fixed}</p>`);
  } else if (swaps.length) {
    const now = est ? ` The deck now reads as Bracket ${est.bracket}${est.bracket !== target ? `, not Bracket ${target}` : ""}.` : "";
    lines.push(`<p>Replaced ${plural(swaps.length, ["card", "cards"])}.${now}</p>`);
  } else {
    lines.push("<p>No cards were changed.</p>");
  }
  const warn = (text) => lines.push(`<p class="result-warn">${escapeHtml(text)}</p>`);
  if (failed) warn("Something went wrong partway through, so the adjustment may be incomplete.");
  if (stuck.length) warn(`No suitable replacement was found for ${stuck.join(", ")}.`);
  if (est && est.bracket > target) {
    if (est.why.length) warn(`Still held at Bracket ${est.bracket} by ${est.why[0].text}.`);
    if (deck.commander.game_changer) warn("The commander itself is a Game Changer, and it can't be swapped out.");
  } else if (est && est.bracket < target) {
    warn(`Only reached Bracket ${est.bracket}: not enough suitable Game Changers were found for this deck's colors.`);
  }
  if (!comboChecked) warn("Two-card combos couldn't be checked, so those weren't adjusted.");
  if (swaps.length) {
    const items = swaps
      .map((s) => `<li>${escapeHtml(s.from.name)} → ${escapeHtml(s.to.name)} <small>(${REASON_LABEL[s.reason][0]})</small></li>`)
      .join("");
    lines.push(`<details><summary>See what changed</summary><ul>${items}</ul></details>`);
  }
  bracketResultEl.innerHTML = lines.join("");
}

function clearAdjustResult() {
  undoState = null;
  bracketResultEl.replaceChildren();
  bracketUndoBtn.classList.add("hidden");
}

// Called on every deck render: a different deck (a rebuild) resets the controls, and any edit
// made after an adjustment retires its Undo, since restoring would throw those edits away.
function noteDeckForAdjust(deck, key) {
  if (deck !== adjustDeck) {
    adjustDeck = deck;
    sliderTouched = false;
    clearAdjustResult();
  } else if (undoState && undoState.key && undoState.key !== key) {
    clearAdjustResult();
  }
}

function syncBracketControls(deck, est, comboInfo) {
  adjustView = { deck, est, comboInfo };
  if (!sliderTouched && !adjustBusy) bracketSlider.value = String(est.bracket);
  refreshAdjustControls();
}

function refreshAdjustControls() {
  if (!adjustView) return;
  const { deck, est, comboInfo } = adjustView;
  const target = Number(bracketSlider.value);
  const lower = target < est.bracket;
  const higher = target > est.bracket;
  bracketSlider.disabled = adjustBusy || budgetBusy;
  bracketSlider.setAttribute("aria-valuetext", `Bracket ${target}, ${BRACKET_NAMES[target]}`);
  bracketApplyBtn.disabled = adjustBusy || budgetBusy || !(lower || higher);
  bracketApplyBtn.textContent = adjustBusy ? "Adjusting…" : lower || higher ? `Adjust deck to Bracket ${target}` : "Adjust deck";
  if (adjustBusy) return;

  if (lower) {
    const plan = planAdjustment(deck, target, comboInfo);
    bracketNoteEl.textContent = plan.length
      ? `This would replace ${plural(plan.length, ["card", "cards"])}: ${describePlan(plan)}.`
      : "Nothing obvious to swap out yet; adjusting will check again.";
  } else if (higher) {
    const gcs = [deck.commander, ...deck.groups.flatMap((g) => g.cards)].filter((c) => c.game_changer).length;
    const n = Math.max(0, RAISE_GOAL[target] - gcs);
    bracketNoteEl.textContent = n
      ? `This would bring in up to ${plural(n, ["Game Changer", "Game Changers"])}, each replacing the least popular card in its group.`
      : "Adjusting will check again.";
  } else if (sliderTouched) {
    bracketNoteEl.textContent = `Already Bracket ${est.bracket}. Drag the slider to a different bracket to change the deck.`;
  } else {
    bracketNoteEl.textContent = "";
  }
}

bracketSlider.addEventListener("input", () => {
  sliderTouched = true;
  refreshAdjustControls();
});
bracketApplyBtn.addEventListener("click", () => adjustDeckToBracket(currentDeck, Number(bracketSlider.value)));
bracketUndoBtn.addEventListener("click", () => {
  if (!undoState || undoState.deck !== currentDeck || adjustBusy) return;
  const { deck, snapshot } = undoState;
  deck.groups.forEach((g, i) => g.cards.splice(0, g.cards.length, ...snapshot[i]));
  clearAdjustResult();
  sliderTouched = false;
  showToast("Put the deck back the way it was.");
  renderDeck(deck);
});

// ---------- Budget ----------
//
// A budget is in estimated CAD (Scryfall's USD prices at the day's exchange rate). Dragging the
// slider (or typing a number) below the deck's current total trims it; above the total, it spends
// the difference bringing in better cards (see runBudgetRaise). Trimming swaps the priciest cards
// for cheaper ones that do the same job, using the same role searches as the Replacements tab plus
// a price ceiling, so the deck stays at 100 cards. Order of preference:
//   1. the same card in a cheaper printing (no change to how the deck plays; the art may differ),
//   2. a cheaper card for the same job, priciest first, but when only a little needs saving it
//      takes the least popular card that saves enough rather than the priciest one.
// The bracket is a floor: a swap that would drop the deck below it isn't made. Where the floor
// needs Game Changers, a card that is one is swapped for a cheaper Game Changer instead.

const PRICE_TIERS = [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 35, 60]; // USD ceilings, so searches repeat and stay cached
const tierAtMost = (usd) => PRICE_TIERS.reduce((best, t) => (t <= usd ? t : best), null);
const parseBudget = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : null;
};
const knownComboInfo = (deck) => bracketComboCache.get(bracketDeckKey(deck)) || { status: "pending" };

// Trims `deck` toward `budget`, never leaving it below `floor`. Needs currentDeck to be `deck`.
async function runBudgetAdjustment(deck, budget, floor, onProgress = () => {}) {
  const fx = await fetchUsdToCad();
  if (!fx) return { unavailable: true, swaps: [], budget };

  const swaps = [];
  const held = []; // cards we couldn't find a cheaper match for: { card, needGc }
  let failed = false;
  const priceMap = new Map();
  const load = async (card) => priceMap.set(card.id || card.name, await resolveCardPrice(card));
  const usdOf = (card) => {
    const info = priceMap.get(card.id || card.name);
    return info ? info.main.usd : 0;
  };
  const cadOf = (card) => unitAmount(usdOf(card), fx);
  let total = 0;

  try {
    onProgress("Pricing the deck…");
    await Promise.all([deck.commander, ...deck.groups.flatMap((g) => g.cards)].map(load));
    total = cadOf(deck.commander) + deck.groups.reduce((s, g) => s + g.cards.reduce((t, c) => t + cadOf(c) * (c.qty || 1), 0), 0);

    const slots = deck.groups.flatMap((group) => (group.isBasics ? [] : group.cards.map((_, index) => ({ group, index }))));
    const cardAt = (s) => s.group.cards[s.index];

    // 1. Cheaper printings of the priciest cards.
    if (total > budget) {
      onProgress("Looking for cheaper printings…");
      const priciest = slots.filter((s) => cadOf(cardAt(s)) >= 2).sort((a, b) => cadOf(cardAt(b)) - cadOf(cardAt(a))).slice(0, 8);
      const cheapestPrintings = await Promise.all(priciest.map((s) => fetchCheapestPrintingQueued(cardAt(s))));
      for (const [i, slot] of priciest.entries()) {
        if (total <= budget) break;
        const card = cardAt(slot);
        const cheapest = cheapestPrintings[i];
        const price = cheapest && cardPrices(cheapest)[0];
        if (!price) continue;
        const saved = cadOf(card) - unitAmount(price.usd, fx);
        if (saved < 1 || saved < cadOf(card) * 0.1) continue; // not worth changing the art for
        await load(cheapest);
        slot.group.cards[slot.index] = cheapest;
        total -= saved;
        swaps.push({ from: card, to: cheapest, reason: "printing", saved });
      }
    }

    // 2. Cheaper cards for the same job.
    const taken = new Set();
    const done = new Set(); // each slot is tried once

    // The searches for a cheaper stand-in for the card in `slot`: its own role first, then just
    // its card type at any cost. `cap` is the USD ceiling for the replacement.
    const swapQueries = (slot, cap, needGc) => {
      const card = cardAt(slot);
      const search = cap === null ? null : replacementSearch(card, { group: slot.group, index: slot.index });
      if (!search) return [];
      const category = cardTypeCategory(card);
      const base = `${identityQueryFragment(deck.identity)} legal:commander -is:commander game:paper`;
      const gcTerm = needGc ? "is:gamechanger" : "-is:gamechanger";
      const queries = [{ query: `${search.query} ${gcTerm} usd<=${cap}`, landsOnly: !!search.landsOnly }];
      if (!search.landsOnly && TYPE_QUERY[category]) {
        queries.push({ query: `${base} ${TYPE_QUERY[category]} ${gcTerm} usd<=${cap} order:edhrec`, landsOnly: false });
      }
      return queries;
    };

    // Load the role searches for the priciest cards a few at a time up front, so the swaps
    // below mostly find their results ready instead of waiting on one request each.
    onProgress("Finding cheaper cards…");
    const warm = new Set();
    slots
      .filter((s) => cadOf(cardAt(s)) >= 1)
      .sort((a, b) => cadOf(cardAt(b)) - cadOf(cardAt(a)))
      .slice(0, 16)
      .forEach((s) => {
        const first = swapQueries(s, tierAtMost(usdOf(cardAt(s)) * 0.5), false)[0];
        if (first && !replacementCache.has(first.query)) warm.add(first.query);
      });
    const warmList = [...warm];
    for (let i = 0; i < warmList.length; i += 5) {
      await Promise.all(warmList.slice(i, i + 5).map((q) => searchPool(q)));
      await sleep(60);
    }

    const swapDown = async (slot) => {
      const card = cardAt(slot);
      const cap = tierAtMost(usdOf(card) * 0.5);
      if (!swapQueries(slot, cap, false).length) return {};

      const info = knownComboInfo(deck);
      const bracketWith = (replacement) => {
        slot.group.cards[slot.index] = replacement;
        const b = estimateBracket(deck, info).bracket;
        slot.group.cards[slot.index] = card;
        return b;
      };
      // If any plain card would take the deck below the floor, only a cheaper Game Changer will do.
      const needGc = bracketWith({ name: "", type_line: "" }) < floor;

      for (const q of swapQueries(slot, cap, needGc)) {
        if (!replacementCache.has(q.query)) await sleep(80);
        const pool = await searchPool(q.query);
        const found = (pool || []).find(
          (c) =>
            !deckHasCard(deck, c.name) && !taken.has(c.name) && !isExtraTurnCard(c) &&
            !MASS_LAND_DENIAL.has(frontFace(c.name).toLowerCase()) && !!c.game_changer === needGc &&
            (!q.landsOnly || isLandRelevant(c, deck.identity)) && (!needGc || bracketWith(c) >= floor)
        );
        if (found) return { found, needGc };
      }
      return { needGc };
    };

    for (let iter = 0; iter < 80 && total > budget; iter++) {
      const over = total - budget;
      let candidates = slots.filter((s) => !done.has(s) && cadOf(cardAt(s)) >= 1);
      const notAdded = candidates.filter((s) => !s.group.isAdded); // cards you added yourself go last
      if (notAdded.length) candidates = notAdded;
      if (!candidates.length) break;

      // Only a little to save: the least popular card that saves enough. Otherwise the priciest.
      const rank = (s) => cardAt(s).edhrec_rank ?? 1e9;
      const enough = candidates.filter((s) => cadOf(cardAt(s)) * 0.7 >= over);
      const pick = enough.length
        ? enough.reduce((a, b) => (rank(b) > rank(a) ? b : a))
        : candidates.reduce((a, b) => (cadOf(cardAt(b)) > cadOf(cardAt(a)) ? b : a));
      done.add(pick);

      onProgress(`Swapping in cheaper cards… (${swaps.length} so far)`);
      const card = cardAt(pick);
      const res = await swapDown(pick);
      if (!res.found) {
        held.push({ card, needGc: !!res.needGc, cad: cadOf(card) });
        continue;
      }
      await load(res.found);
      const saved = cadOf(card) - cadOf(res.found);
      if (saved <= 0) continue;
      pick.group.cards[pick.index] = res.found;
      taken.add(res.found.name);
      total -= saved;
      swaps.push({ from: card, to: res.found, reason: "budget", saved });
    }
  } catch (err) {
    console.error(err);
    failed = true;
  }
  return { swaps, held, failed, total, budget, floor, fx, commanderCad: cadOf(deck.commander), kind: "trim" };
}

// Spends whatever's left of the budget on more popular (and pricier) versions of what's already
// there: the same role searches as the trim above, but hunting for a card that costs more and
// still fits, starting from the least popular card in the deck each time — the one with the most
// obvious room to trade up. It never brings in a Game Changer, mass land denial or an extra-turn
// spell (the target bracket already controls those, and spending more shouldn't change the
// bracket on its own), and it leaves cards you added yourself and the basics alone. Best-effort,
// like the trim: a card with no better match in its price range just stays put. Needs currentDeck
// to be `deck` (replacementSearch reads it).
async function runBudgetRaise(deck, budget, floor, onProgress = () => {}) {
  const fx = await fetchUsdToCad();
  if (!fx) return { unavailable: true, swaps: [], budget };

  const swaps = [];
  let failed = false;
  const priceMap = new Map();
  const load = async (card) => priceMap.set(card.id || card.name, await resolveCardPrice(card));
  const usdOf = (card) => {
    const info = priceMap.get(card.id || card.name);
    return info ? info.main.usd : 0;
  };
  const cadOf = (card) => unitAmount(usdOf(card), fx);
  let total = 0;
  let startTotal = 0;

  try {
    onProgress("Pricing the deck…");
    await Promise.all([deck.commander, ...deck.groups.flatMap((g) => g.cards)].map(load));
    total = cadOf(deck.commander) + deck.groups.reduce((s, g) => s + g.cards.reduce((t, c) => t + cadOf(c) * (c.qty || 1), 0), 0);
    startTotal = total;

    const slots = deck.groups.flatMap((group) =>
      group.isBasics || group.isAdded ? [] : group.cards.map((_, index) => ({ group, index }))
    );
    const cardAt = (s) => s.group.cards[s.index];
    const taken = new Set();
    const done = new Set(); // each slot is tried once

    // The searches for a stronger stand-in for the card in `slot`: its own role first, then just
    // its card type. `cap` is the USD ceiling, so a search stays inside what's left to spend.
    const raiseQueries = (slot, cap) => {
      const card = cardAt(slot);
      const search = replacementSearch(card, { group: slot.group, index: slot.index });
      if (!search) return [];
      const category = cardTypeCategory(card);
      const base = `${identityQueryFragment(deck.identity)} legal:commander -is:commander game:paper`;
      const queries = [{ query: `${search.query} -is:gamechanger usd<=${cap}`, landsOnly: !!search.landsOnly }];
      if (!search.landsOnly && TYPE_QUERY[category]) {
        queries.push({ query: `${base} ${TYPE_QUERY[category]} -is:gamechanger usd<=${cap} order:edhrec`, landsOnly: false });
      }
      return queries;
    };

    onProgress("Finding better cards…");
    for (let iter = 0; iter < 60 && budget - total > 0.5; iter++) {
      const candidates = slots.filter((s) => !done.has(s));
      if (!candidates.length) break;
      // Least popular card first — the one with the most obvious room to trade up.
      const rank = (s) => cardAt(s).edhrec_rank ?? 1e9;
      const pick = candidates.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      done.add(pick);

      const card = cardAt(pick);
      const roomUsd = (budget - total) / fx.rate;
      // Don't let one card eat the whole remaining budget — cap the jump so several cards can
      // improve, not just one.
      const cap = tierAtMost(Math.min(roomUsd, usdOf(card) * 4 + 10));
      if (cap === null || cap <= usdOf(card)) continue;

      onProgress(`Finding better cards… (${swaps.length} so far)`);
      let found = null;
      for (const q of raiseQueries(pick, cap)) {
        if (!replacementCache.has(q.query)) await sleep(60);
        const pool = await searchPool(q.query);
        found = (pool || []).find((c) => {
          if (deckHasCard(deck, c.name) || taken.has(c.name)) return false;
          if (c.game_changer || isExtraTurnCard(c) || MASS_LAND_DENIAL.has(frontFace(c.name).toLowerCase())) return false;
          if (q.landsOnly && !isLandRelevant(c, deck.identity)) return false;
          const price = cardPrices(c)[0];
          return price && price.usd > usdOf(card) + 0.01; // a real upgrade, not a sideways move
        });
        if (found) break;
      }
      if (!found) continue;

      await load(found);
      const cost = cadOf(found) - cadOf(card);
      if (cost <= 0 || total + cost > budget + 0.005) continue;
      pick.group.cards[pick.index] = found;
      taken.add(found.name);
      total += cost;
      swaps.push({ from: card, to: found, reason: "upgrade", cost });
    }
  } catch (err) {
    console.error(err);
    failed = true;
  }
  return { swaps, held: [], failed, total, startTotal, budget, floor, fx, kind: "raise" };
}

function showBudgetResult(res, built) {
  const box = el("budget-result");
  if (res.unavailable) {
    box.innerHTML = `<p class="result-warn">${escapeHtml("Couldn't load the exchange rate, so the budget wasn't applied.")}</p>`;
    return;
  }
  const money = (n) => `≈ ${formatAmount(n, res.fx)}`;
  const lines = [];
  const warn = (text) => lines.push(`<p class="result-warn">${escapeHtml(text)}</p>`);

  if (res.kind === "raise") {
    if (res.swaps.length) {
      const spent = res.total - res.startTotal;
      lines.push(
        `<p>Spent ${money(spent)} on ${plural(res.swaps.length, ["a more popular card", "more popular cards"])}: the deck now comes to ${money(res.total)}.</p>`
      );
    } else {
      lines.push(`<p>Nothing changed — no more popular card was found in reach of the budget.</p>`);
    }
    if (res.failed) warn("Something went wrong partway through, so the result may be incomplete.");
  } else {
    const reached = res.total <= res.budget + 0.005;
    if (!res.swaps.length && reached) lines.push(`<p>Already within budget: ${money(res.total)}.</p>`);
    else if (reached) lines.push(`<p>${built ? "Built to fit" : "Trimmed to fit"} a budget of ${money(res.budget)}: the deck comes to ${money(res.total)}.</p>`);
    else lines.push(`<p>Couldn't reach ${money(res.budget)}. It got as low as ${money(res.total)}.</p>`);

    if (res.failed) warn("Something went wrong partway through, so the result may be incomplete.");
    if (!reached) {
      if (res.commanderCad > res.budget * 0.25) warn(`The commander alone is ${money(res.commanderCad)}.`);
      const names = (list) => list.slice(0, 5).map((h) => h.card.name).join(", ");
      const kept = res.held.filter((h) => h.needGc);
      const noMatch = res.held.filter((h) => !h.needGc);
      if (kept.length) warn(`${plural(kept.length, ["Game Changer", "Game Changers"])} kept to hold Bracket ${res.floor}: ${names(kept)}.`);
      if (noMatch.length) warn(`No cheaper match was found for ${names(noMatch)}.`);
      if (!res.held.length) warn("What's left is mostly inexpensive cards, so going lower would mean cutting real staples.");
    }
  }

  if (res.swaps.length) {
    const items = res.swaps
      .map((s) => {
        if (s.reason === "upgrade") return `<li>${escapeHtml(s.from.name)} → ${escapeHtml(s.to.name)} <small>(${money(s.cost)} more)</small></li>`;
        const how = s.reason === "printing" ? "cheaper printing, " : "";
        return `<li>${escapeHtml(s.from.name)} → ${escapeHtml(s.to.name)} <small>(${how}saves ${money(s.saved)})</small></li>`;
      })
      .join("");
    lines.push(`<details><summary>See what changed</summary><ul>${items}</ul></details>`);
  }
  box.innerHTML = lines.join("");
}

const budgetInput = el("budget-input");
const budgetSlider = el("budget-slider");
const budgetApplyBtn = el("budget-apply");
const budgetUndoBtn = el("budget-undo");
const budgetNoteEl = el("budget-note");
let budgetBusy = false;
let budgetUndoState = null; // { deck, snapshot, key } while the last budget change can be undone
let budgetDeck = null; // the deck the controls are about; a new deck starts with no budget

function clearBudgetResult() {
  budgetUndoState = null;
  el("budget-result").replaceChildren();
  budgetUndoBtn.classList.add("hidden");
}

// Called on every deck render, like noteDeckForAdjust.
function noteDeckForBudget(deck, key) {
  if (deck !== budgetDeck) {
    budgetDeck = deck;
    budgetInput.value = "";
    clearBudgetResult();
  } else if (budgetUndoState && budgetUndoState.key && budgetUndoState.key !== key) {
    clearBudgetResult();
  }
}

function refreshBudgetControls() {
  if (!currentDeck) return;
  el("budget-panel").classList.remove("hidden");
  const busy = budgetBusy || adjustBusy;
  budgetInput.disabled = busy;
  budgetSlider.disabled = busy;
  budgetApplyBtn.textContent = budgetBusy ? "Adjusting…" : "Adjust to budget";
  budgetApplyBtn.disabled = true;
  if (busy) return;
  if (!deckTotal || deckTotal.deck !== currentDeck) {
    budgetNoteEl.textContent = "Pricing the deck…";
    return;
  }
  const { total, fx } = deckTotal;
  if (!fx) {
    budgetNoteEl.textContent = "The exchange rate isn't available right now, so a budget can't be applied.";
    return;
  }
  // The slider needs to reach above the deck's current total too, or there's nothing to drag it
  // up to — give it at least as much headroom above the total as half the total itself (and at
  // least $200), so raising it is actually possible, not just trimming.
  const headroom = Math.max(200, total * 0.5);
  const max = Math.max(100, Math.ceil((total + headroom) / 50) * 50);
  const budget = parseBudget(budgetInput.value);
  budgetSlider.max = String(max);
  budgetSlider.value = String(budget ? Math.min(max, Math.max(25, budget)) : Math.ceil(total / 50) * 50);
  el("budget-tick-max").textContent = `$${max.toLocaleString("en-CA")}`;

  const money = (n) => `≈ ${formatAmount(n, fx)}`;
  const floor = adjustView ? adjustView.est.bracket : 2;
  const diff = budget ? budget - total : 0; // positive: room to spend; negative: over
  if (!budget) {
    budgetNoteEl.textContent = `The deck comes to ${money(total)}. Type a budget or drag the slider to trim it.`;
  } else if (diff < -0.005) {
    budgetApplyBtn.disabled = false;
    budgetNoteEl.textContent = `Over by ${money(-diff)}. Adjusting swaps the priciest cards for cheaper ones in the same role, and never takes the deck below Bracket ${floor}.`;
  } else if (diff > 1) {
    budgetApplyBtn.disabled = false;
    budgetNoteEl.textContent = `${money(diff)} to spare. Adjusting looks for more popular cards in the same roles that cost more, up to your budget.`;
  } else {
    budgetNoteEl.textContent = `Right at budget: ${money(total)} of ${money(budget)}.`;
  }
}

async function adjustDeckToBudget(deck, budget) {
  if (adjustBusy || budgetBusy || !deck) return;
  const currentTotal = deckTotal && deckTotal.deck === deck ? deckTotal.total : null;
  const raising = currentTotal !== null && budget > currentTotal + 0.005;
  budgetBusy = true;
  clearBudgetResult();
  refreshBudgetControls();
  refreshAdjustControls();

  const snapshot = deck.groups.map((g) => g.cards.slice());
  const floor = adjustView ? adjustView.est.bracket : 2;
  const progress = (text) => {
    budgetNoteEl.textContent = text;
  };
  const res = raising ? await runBudgetRaise(deck, budget, floor, progress) : await runBudgetAdjustment(deck, budget, floor, progress);

  budgetBusy = false;
  if (res.swaps.length) {
    budgetUndoState = { deck, snapshot, key: null };
    renderDeck(deck);
    budgetUndoState.key = bracketDeckKey(deck);
    budgetUndoBtn.classList.remove("hidden");
  } else {
    refreshBudgetControls();
  }
  refreshAdjustControls();
  showBudgetResult(res, false);
}

budgetSlider.addEventListener("input", () => {
  budgetInput.value = budgetSlider.value;
  refreshBudgetControls();
});
budgetInput.addEventListener("input", refreshBudgetControls);
budgetApplyBtn.addEventListener("click", () => {
  const budget = parseBudget(budgetInput.value);
  if (budget) adjustDeckToBudget(currentDeck, budget);
});
budgetUndoBtn.addEventListener("click", () => {
  if (!budgetUndoState || budgetUndoState.deck !== currentDeck || budgetBusy || adjustBusy) return;
  const { deck, snapshot } = budgetUndoState;
  deck.groups.forEach((g, i) => g.cards.splice(0, g.cards.length, ...snapshot[i]));
  clearBudgetResult();
  showToast("Put the deck back the way it was.");
  renderDeck(deck);
});

const rulingsCache = new Map();
async function fetchRulings(card) {
  if (!card.id) return [];
  if (rulingsCache.has(card.id)) return rulingsCache.get(card.id);
  if (!card.rulings_uri) return [];
  try {
    const res = await fetch(card.rulings_uri);
    if (!res.ok) return [];
    const data = await res.json();
    const rulings = data.data || [];
    rulingsCache.set(card.id, rulings);
    return rulings;
  } catch {
    return [];
  }
}

function renderRulings(rulings) {
  if (!rulings.length) {
    modalPanelEl.innerHTML = modalNote("No official rulings for this card.");
    return;
  }
  modalPanelEl.innerHTML = rulings
    .map((r) => `<div class="ruling"><span class="ruling-date">${escapeHtml(r.published_at)}</span>${escapeHtml(r.comment)}</div>`)
    .join("");
}

function renderCurve(deck) {
  const nonland = deck.groups
    .filter((g) => g.name !== "Nonbasic Lands" && g.name !== "Basic Lands")
    .flatMap((g) => g.cards);
  const buckets = new Array(8).fill(0); // 0,1,2,3,4,5,6,7+
  nonland.forEach((c) => {
    const cmc = Math.min(7, Math.floor(cardCmc(c)));
    buckets[cmc]++;
  });
  const max = Math.max(1, ...buckets);
  const chart = el("curve-chart");
  chart.innerHTML = "";
  buckets.forEach((count, i) => {
    const wrap = document.createElement("div");
    wrap.className = "curve-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "curve-bar";
    bar.style.height = `${(count / max) * 100}%`;
    const countLabel = document.createElement("div");
    countLabel.className = "curve-count";
    countLabel.textContent = count || "";
    const label = document.createElement("div");
    label.className = "curve-label";
    label.textContent = i === 7 ? "7+" : i;
    wrap.appendChild(countLabel);
    wrap.appendChild(bar);
    wrap.appendChild(label);
    chart.appendChild(wrap);
  });
}

// ---------- Drag & drop: add cards from search, remove cards via the Graveyard zone ----------

const BASIC_LAND_NAMES = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"]);

function deckHasCard(deck, name) {
  const key = normalizeName(name);
  if (normalizeName(deck.commander.name) === key) return true;
  return deck.groups.some((g) => !g.isBasics && g.cards.some((c) => normalizeName(c.name) === key));
}

let toastTimer = null;
function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

// Removes one copy of the card at group.cards[idx]. Stacked basics decrement their
// qty instead of disappearing outright, so "one card" leaves the stack each drag.
function removeOneCopy(group, idx) {
  const card = group.cards[idx];
  if (card.qty && card.qty > 1) {
    card.qty -= 1;
  } else {
    group.cards.splice(idx, 1);
  }
}

// Adds a card dragged from search. Basic lands merge into the existing Basic Lands
// stack (incrementing qty) instead of creating a second, separate tile.
function addCardToDeck(deck, card) {
  if (deckHasCard(deck, card.name) && !BASIC_LAND_NAMES.has(card.name)) {
    showToast(`${card.name} is already in the deck.`);
    return false;
  }
  if (BASIC_LAND_NAMES.has(card.name)) {
    const basicsGroup = deck.groups.find((g) => g.isBasics);
    const existing = basicsGroup.cards.find((c) => normalizeName(c.name) === normalizeName(card.name));
    if (existing) {
      existing.qty = (existing.qty || 1) + 1;
    } else {
      basicsGroup.cards.push({ ...card, qty: 1 });
    }
  } else {
    const addedGroup = deck.groups.find((g) => g.isAdded);
    addedGroup.cards.push({ ...card, qty: 1 });
  }
  return true;
}

// Wires a deck-tile for the "drag to the floating Graveyard zone to remove" gesture.
// Long-press-then-drag for touch screens. HTML5 drag-and-drop (dragstart/dragover/drop,
// used everywhere above) only fires for mouse input — touch browsers never trigger it —
// so phones need this separate, pointerType-gated path. It only ever activates for an
// actual touch pointer, so mouse/trackpad interaction on desktop is completely untouched.
function attachLongPressDrag(tile, { onStart, onMove, onDrop, onCancel }) {
  tile.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const timer = setTimeout(() => {
      dragging = true;
      if (navigator.vibrate) navigator.vibrate(12);
      onStart(e);
    }, 350);

    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) clearTimeout(timer);
        return;
      }
      ev.preventDefault();
      onMove(ev);
    };
    const finish = (ev, cancelled) => {
      clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancelHandler);
      if (dragging) {
        suppressClickUntil = Date.now() + 600; // the finger lifting can register as a click on the tile
        if (cancelled) onCancel && onCancel();
        else onDrop(ev);
      }
    };
    const up = (ev) => finish(ev, false);
    const cancelHandler = (ev) => finish(ev, true);

    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancelHandler);
  });
}

function createTouchGhost(tile, e) {
  const ghost = document.createElement("div");
  ghost.className = "touch-drag-ghost";
  const img = tile.querySelector("img");
  if (img) ghost.appendChild(img.cloneNode(true));
  document.body.appendChild(ghost);
  positionTouchGhost(ghost, e);
  return ghost;
}
function positionTouchGhost(ghost, e) {
  if (!ghost || !e) return;
  ghost.style.left = e.clientX + "px";
  ghost.style.top = e.clientY + "px";
}

function makeRemovable(tile, group, idx) {
  tile.draggable = true;
  tile.classList.add("remove-target");
  tile.addEventListener("dragstart", (e) => {
    dragState = { type: "remove", group, index: idx };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "remove");
    tile.classList.add("dragging");
    spawnGraveyardZone(tile);
  });
  tile.addEventListener("dragend", () => {
    tile.classList.remove("dragging");
    dragState = null;
    removeGraveyardZone();
  });

  let touchGhost = null;
  const endTouchDrag = () => {
    tile.classList.remove("dragging");
    dragState = null;
    removeGraveyardZone();
    if (touchGhost) {
      touchGhost.remove();
      touchGhost = null;
    }
  };
  attachLongPressDrag(tile, {
    onStart: (e) => {
      dragState = { type: "remove", group, index: idx };
      tile.classList.add("dragging");
      spawnGraveyardZone(tile);
      touchGhost = createTouchGhost(tile, e);
    },
    onMove: (e) => {
      positionTouchGhost(touchGhost, e);
      const over = document.elementFromPoint(e.clientX, e.clientY);
      if (graveyardEl) graveyardEl.classList.toggle("hover", !!(over && over.closest(".graveyard-zone")));
    },
    onDrop: (e) => {
      const over = document.elementFromPoint(e.clientX, e.clientY);
      if (over && over.closest(".graveyard-zone")) {
        const card = group.cards[idx];
        removeOneCopy(group, idx);
        showToast(`Removed ${card.name}.`);
        renderDeck(currentDeck);
      }
      endTouchDrag();
    },
    onCancel: endTouchDrag,
  });
}

let graveyardEl = null;
function spawnGraveyardZone(tile) {
  removeGraveyardZone();
  const rect = tile.getBoundingClientRect();
  const w = rect.width * 1.15;
  const h = rect.height * 1.15;
  let left = rect.right + 14;
  let top = Math.max(8, rect.top - h - 14);
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);

  graveyardEl = document.createElement("div");
  graveyardEl.className = "graveyard-zone";
  graveyardEl.textContent = "Graveyard";
  graveyardEl.style.left = `${left}px`;
  graveyardEl.style.top = `${top}px`;
  graveyardEl.style.width = `${w}px`;
  graveyardEl.style.height = `${h}px`;

  graveyardEl.addEventListener("dragenter", (e) => {
    if (dragState?.type !== "remove") return;
    e.preventDefault();
  });
  graveyardEl.addEventListener("dragover", (e) => {
    if (dragState?.type !== "remove") return;
    e.preventDefault();
    graveyardEl.classList.add("hover");
  });
  graveyardEl.addEventListener("dragleave", () => graveyardEl.classList.remove("hover"));
  graveyardEl.addEventListener("drop", (e) => {
    if (dragState?.type !== "remove") return;
    e.preventDefault();
    const { group, index } = dragState;
    const card = group.cards[index];
    removeOneCopy(group, index);
    showToast(`Removed ${card.name}.`);
    renderDeck(currentDeck);
  });

  document.body.appendChild(graveyardEl);
}
function removeGraveyardZone() {
  if (graveyardEl) {
    graveyardEl.remove();
    graveyardEl = null;
  }
}

// ---------- Add-card search ----------

const addCardInput = el("add-card-input");
const addCardResults = el("add-card-results");
let addCardDebounce = null;

addCardInput.addEventListener("input", () => {
  const q = addCardInput.value.trim();
  clearTimeout(addCardDebounce);
  if (q.length < 2) {
    addCardResults.innerHTML = "";
    return;
  }
  addCardDebounce = setTimeout(() => runAddCardSearch(q), 300);
});

async function runAddCardSearch(query) {
  if (!currentDeck) return;
  try {
    const escaped = query.replace(/"/g, '\\"');
    const idFrag = identityQueryFragment(currentDeck.identity);
    const pool = await scryfallSearch(`${idFrag} legal:commander ("${escaped}") order:edhrec`, { limit: 16 });
    const results = pool.filter((c) => !deckHasCard(currentDeck, c.name) || BASIC_LAND_NAMES.has(c.name));
    addCardResults.innerHTML = "";
    if (!results.length) {
      addCardResults.innerHTML = `<p class="add-card-empty">No matching cards in this deck's colors.</p>`;
      return;
    }
    results.forEach((card) => {
      const tile = cardTile(card, 1);
      makeAddable(tile, card);
      addCardResults.appendChild(tile);
    });
  } catch (e) {
    addCardResults.innerHTML = `<p class="add-card-empty">Search error: ${escapeHtml(e.message)}</p>`;
  }
}

function makeAddable(tile, card) {
  tile.draggable = true;
  tile.addEventListener("dragstart", (e) => {
    dragState = { type: "add", card };
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", "add");
    tile.classList.add("dragging");
  });
  tile.addEventListener("dragend", () => {
    tile.classList.remove("dragging");
    dragState = null;
  });

  let touchGhost = null;
  const endTouchDrag = () => {
    tile.classList.remove("dragging");
    dragState = null;
    deckGroupsEl.classList.remove("drop-hover");
    if (touchGhost) {
      touchGhost.remove();
      touchGhost = null;
    }
  };
  attachLongPressDrag(tile, {
    onStart: (e) => {
      dragState = { type: "add", card };
      tile.classList.add("dragging");
      touchGhost = createTouchGhost(tile, e);
    },
    onMove: (e) => {
      positionTouchGhost(touchGhost, e);
      const over = document.elementFromPoint(e.clientX, e.clientY);
      deckGroupsEl.classList.toggle("drop-hover", !!(over && over.closest("#deck-groups")));
    },
    onDrop: (e) => {
      const over = document.elementFromPoint(e.clientX, e.clientY);
      if (over && over.closest("#deck-groups")) {
        if (addCardToDeck(currentDeck, card)) {
          showToast(`Added ${card.name}.`);
          renderDeck(currentDeck);
        }
      }
      endTouchDrag();
    },
    onCancel: endTouchDrag,
  });
}

const deckGroupsEl = el("deck-groups");
deckGroupsEl.addEventListener("dragenter", (e) => {
  if (dragState?.type !== "add") return;
  e.preventDefault();
});
deckGroupsEl.addEventListener("dragover", (e) => {
  if (dragState?.type !== "add") return;
  e.preventDefault();
  deckGroupsEl.classList.add("drop-hover");
});
deckGroupsEl.addEventListener("dragleave", (e) => {
  if (!deckGroupsEl.contains(e.relatedTarget)) deckGroupsEl.classList.remove("drop-hover");
});
deckGroupsEl.addEventListener("drop", (e) => {
  if (dragState?.type !== "add") return;
  e.preventDefault();
  deckGroupsEl.classList.remove("drop-hover");
  const { card } = dragState;
  if (addCardToDeck(currentDeck, card)) {
    showToast(`Added ${card.name}.`);
    renderDeck(currentDeck);
  }
});

// ---------- Group-by toggle ----------

document.querySelectorAll("#view-toggle .toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === viewMode) return;
    viewMode = btn.dataset.mode;
    document.querySelectorAll("#view-toggle .toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
    if (currentDeck) renderDeck(currentDeck);
  });
});

el("copy-btn").addEventListener("click", async () => {
  const deck = currentDeck;
  if (!deck) return;
  const lines = [`1 ${deck.commander.name}`];
  deck.groups.forEach((g) => {
    g.cards.forEach((c) => lines.push(`${c.qty || 1} ${c.name}`));
  });
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    const btn = el("copy-btn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = original), 1500);
  } catch {
    alert(text);
  }
});
