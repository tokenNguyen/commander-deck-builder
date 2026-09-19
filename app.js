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
async function fetchBasicLandCards(entries) {
  const cache = new Map();
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

  el("archidekt-panel").classList.add("hidden");
  fetchArchidektDecks(card).then((decks) => {
    if (!selectedCommander || selectedCommander.id !== card.id) return;
    renderArchidektDecks(decks);
  });
}

// Most-viewed public Commander decks on Archidekt for this commander, through /api/proxy
// (Archidekt blocks direct browser requests). Hidden whenever the lookup isn't available.
const archidektCache = new Map();
function fetchArchidektDecks(card) {
  if (!archidektCache.has(card.id)) {
    const promise = (async () => {
      try {
        const res = await fetch(`/api/proxy?target=archidekt&commander=${encodeURIComponent(card.name)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data.decks) ? data.decks : null;
      } catch {
        return null;
      }
    })();
    archidektCache.set(card.id, promise);
    promise.then((result) => {
      if (result === null) archidektCache.delete(card.id);
    });
  }
  return archidektCache.get(card.id);
}

function renderArchidektDecks(decks) {
  const list = el("archidekt-list");
  list.innerHTML = "";
  const usable = (decks || []).filter((d) => typeof d.url === "string" && d.url.startsWith("https://archidekt.com/decks/"));
  if (!usable.length) {
    el("archidekt-panel").classList.add("hidden");
    return;
  }
  usable.forEach((d) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = d.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = d.name || "Untitled deck";
    const meta = document.createElement("span");
    meta.className = "meta";
    const bits = [];
    if (d.owner) bits.push(`by ${d.owner}`);
    bits.push(`${(d.views || 0).toLocaleString()} views`);
    if (d.bracket) bits.push(`Bracket ${d.bracket}`);
    meta.textContent = bits.join(" · ");
    li.append(a, meta);
    list.appendChild(li);
  });
  el("archidekt-panel").classList.remove("hidden");
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
    const targets = { ...DEFAULT_TARGETS, ...(archetype.targets || {}) };
    const extraFilter = archetype.extraFilter ? ` ${archetype.extraFilter}` : "";

    const identity = selectedCommander.color_identity || [];
    const idFrag = identityQueryFragment(identity);
    const legalBase = `${idFrag} legal:commander -is:commander game:paper`;
    const used = new Set([normalizeName(selectedCommander.name)]);

    const takeFresh = (pool, n) => {
      const picked = [];
      for (const c of pool) {
        const key = normalizeName(c.name);
        if (used.has(key)) continue;
        used.add(key);
        picked.push(c);
        if (picked.length >= n) break;
      }
      return picked;
    };

    // For a dynamic EDHREC archetype, pull that exact commander+theme's card pools up
    // front so every category below leans on real EDHREC data, not just a small
    // "synergy" slice — this is what actually makes a deck feel built around the theme.
    let themePools = null; // { synergy, ramp, lands, fill }
    let themeNameSet = null; // every card name EDHREC associates with this commander+theme
    let synergyNote = "";
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
        synergyNote = "Couldn't load EDHREC data for this theme — used goodstuff picks instead.";
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

    await setStatus("Finding ramp...");
    const rampCandidates = [...(themePools?.ramp || []), ...(await scryfallSearch(`${legalBase} otag:ramp order:edhrec`, { limit: 60 }))];
    const ramp = takeFresh(rampCandidates, targets.ramp);
    await sleep(90);

    await setStatus("Finding removal...");
    const removalPool = prioritizeByTheme(await scryfallSearch(`${legalBase} otag:removal order:edhrec`, { limit: 60 }));
    const removal = takeFresh(removalPool, targets.removal);
    await sleep(90);

    let wipe = [];
    if (targets.wipe > 0) {
      await setStatus("Finding board wipes...");
      const wipePool = prioritizeByTheme(await scryfallSearch(`${legalBase} otag:board-wipe order:edhrec`, { limit: 40 }));
      wipe = takeFresh(wipePool, targets.wipe);
      await sleep(90);
    }

    await setStatus("Finding card draw...");
    const drawPool = prioritizeByTheme(await scryfallSearch(`${legalBase} otag:card-advantage order:edhrec`, { limit: 60 }));
    let draw = takeFresh(drawPool, targets.draw);
    if (draw.length < targets.draw) {
      const drawPool2 = prioritizeByTheme(await scryfallSearch(`${legalBase} otag:card-draw order:edhrec`, { limit: 60 }));
      draw = draw.concat(takeFresh(drawPool2, targets.draw - draw.length));
    }
    await sleep(90);

    await setStatus("Finding nonbasic lands...");
    const landCandidates = [
      ...(themePools?.lands || []),
      ...(await scryfallSearch(`${idFrag} legal:commander t:land -t:basic game:paper order:edhrec`, { limit: 60 })),
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
        const pool = await scryfallSearch(`${legalBase} ${tribalQuery} order:edhrec`, { limit: 60 });
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
      const pool = await scryfallSearch(`${legalBase} ${archetype.synergyQuery}${extraFilter} order:edhrec`, { limit: 60 });
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
      if (!fillPool) fillPool = await scryfallSearch(`${legalBase} -t:land${extraFilter} order:edhrec`, { limit: 200 });
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
    const basicCards = await fetchBasicLandCards(basics.entries);

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

    const deck = {
      commander: selectedCommander,
      archetypeLabel: archetype.label,
      synergyNote,
      identity,
      groups,
    };

    currentDeck = deck;
    renderDeck(deck);
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
    wrap.innerHTML = `<h3><span>${escapeHtml(dg.name)}</span><span>${count}</span></h3>`;
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
  if (qty > 1) {
    const badge = document.createElement("span");
    badge.className = "qty-badge";
    badge.textContent = `×${qty}`;
    tile.appendChild(badge);
  }
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

async function renderPrice(card, token) {
  modalPriceEl.classList.add("hidden");
  modalPriceEl.textContent = "";
  const stale = () => !modalState || modalState.token !== token; // window moved on while we waited

  let prices = cardPrices(card);
  let fallbackSet = null;
  if (!prices.length) {
    const cheapest = await fetchCheapestPrinting(card);
    if (stale() || !cheapest) return;
    prices = cardPrices(cheapest);
    fallbackSet = cheapest.set_name;
  }
  if (!prices.length) return;

  const fx = await fetchUsdToCad();
  if (stale()) return;

  const usd = (n) => `US$${n.toFixed(2)}`;
  const show = (p) => (fx ? `$${(p.usd * fx.rate).toFixed(2)} CAD` : usd(p.usd));
  const [main, ...others] = prices;

  const line = document.createElement("div");
  line.className = "price-line";
  const mainEl = document.createElement("span");
  mainEl.className = "price-main";
  mainEl.textContent = `${fx ? "≈ " : ""}${show(main)}${main.label ? ` (${main.label})` : ""}`;
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
function fetchReplacements(card, ctx) {
  const search = replacementSearch(card, ctx);
  if (!search) return Promise.resolve({ label: "", cards: [] });
  if (!replacementCache.has(search.query)) {
    const promise = scryfallSearch(search.query, { limit: 60 }).catch(() => null);
    replacementCache.set(search.query, promise);
    promise.then((pool) => {
      if (pool === null) replacementCache.delete(search.query); // don't remember failures
    });
  }
  return replacementCache.get(search.query).then((pool) => {
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
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "secondary swap-btn";
    swap.textContent = "Swap in";
    swap.setAttribute("aria-label", `Swap ${card.name} for ${c.name}`);
    swap.addEventListener("click", () => swapCard(ctx, card, c));
    item.append(name, swap);
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
