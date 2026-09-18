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

function selectCommander(card) {
  selectedCommander = card;
  resultsBox.classList.add("hidden");
  input.value = card.name;

  el("commander-image").src = cardArt(card, "normal") || "";
  el("commander-name").textContent = card.name;
  el("commander-type").textContent = card.type_line || "";
  el("commander-text").textContent = card.oracle_text || (card.card_faces ? card.card_faces.map((f) => f.oracle_text).join("\n---\n") : "");

  const colors = card.color_identity && card.color_identity.length ? card.color_identity : ["C"];
  el("commander-colors").innerHTML = colors
    .map((c) => `<div class="pip pip-${c}">${c}</div>`)
    .join("");

  el("commander-panel").classList.remove("hidden");
  el("deck-panel").classList.add("hidden");
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

const archetypeSelect = el("archetype-select");
Object.entries(ARCHETYPES).forEach(([key, a]) => {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = a.label;
  archetypeSelect.appendChild(opt);
});

function updateArchetypeDesc() {
  const a = ARCHETYPES[archetypeSelect.value] || ARCHETYPES.balanced;
  el("archetype-desc").textContent = a.description || "";
}
archetypeSelect.addEventListener("change", updateArchetypeDesc);
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
    const archetype = ARCHETYPES[archetypeSelect.value] || ARCHETYPES.balanced;
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

    await setStatus("Finding ramp...");
    const rampPool = await scryfallSearch(`${legalBase} otag:ramp order:edhrec`, { limit: 60 });
    const ramp = takeFresh(rampPool, targets.ramp);
    await sleep(90);

    await setStatus("Finding removal...");
    const removalPool = await scryfallSearch(`${legalBase} otag:removal order:edhrec`, { limit: 60 });
    const removal = takeFresh(removalPool, targets.removal);
    await sleep(90);

    let wipe = [];
    if (targets.wipe > 0) {
      await setStatus("Finding board wipes...");
      const wipePool = await scryfallSearch(`${legalBase} otag:board-wipe order:edhrec`, { limit: 40 });
      wipe = takeFresh(wipePool, targets.wipe);
      await sleep(90);
    }

    await setStatus("Finding card draw...");
    const drawPool = await scryfallSearch(`${legalBase} otag:card-advantage order:edhrec`, { limit: 60 });
    let draw = takeFresh(drawPool, targets.draw);
    if (draw.length < targets.draw) {
      const drawPool2 = await scryfallSearch(`${legalBase} otag:card-draw order:edhrec`, { limit: 60 });
      draw = draw.concat(takeFresh(drawPool2, targets.draw - draw.length));
    }
    await sleep(90);

    await setStatus("Finding nonbasic lands...");
    const landPool = await scryfallSearch(`${idFrag} legal:commander t:land -t:basic game:paper order:edhrec`, { limit: 60 });
    const relevantLandPool = landPool.filter((c) => isLandRelevant(c, identity));
    const nonbasicLands = takeFresh(relevantLandPool, targets.nonbasicLands);
    await sleep(90);

    const fixedNonland = ramp.length + removal.length + wipe.length + draw.length;
    const fillNeeded = Math.max(0, 99 - targets.totalLands - fixedNonland);

    // Archetype synergy pool: pulls themed cards (sacrifice outlets, token makers, etc.)
    // before the general goodstuff pool fills whatever's left.
    let synergy = [];
    let synergyNote = "";
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
    } else if (archetype.synergyQuery) {
      await setStatus(`Finding ${archetype.label} synergy cards...`);
      const pool = await scryfallSearch(`${legalBase} ${archetype.synergyQuery}${extraFilter} order:edhrec`, { limit: 60 });
      synergy = takeFresh(pool, Math.min(archetype.synergyCount, fillNeeded));
      await sleep(90);
    }

    await setStatus("Rounding out the rest of the deck...");
    const generalFillNeeded = fillNeeded - synergy.length;
    const fillPool = await scryfallSearch(`${legalBase} -t:land${extraFilter} order:edhrec`, { limit: 200 });
    const fill = takeFresh(fillPool, generalFillNeeded);

    // If any category came up short (small/obscure color identity), pad from the general pool.
    let shortfall = 99 - targets.totalLands - (fixedNonland + synergy.length + fill.length);
    if (shortfall > 0) {
      const extra = takeFresh(fillPool, shortfall);
      fill.push(...extra);
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
      { name: "Nonbasic Lands", cards: nonbasicLands },
      { name: "Basic Lands", cards: basicCards }
    );

    const deck = {
      commander: selectedCommander,
      archetypeLabel: archetype.label,
      synergyNote,
      groups,
    };

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

  for (const group of deck.groups) {
    if (!group.cards.length) continue;
    const count = group.cards.reduce((s, c) => s + (c.qty || 1), 0);
    const wrap = document.createElement("div");
    wrap.className = "deck-group";
    wrap.innerHTML = `<h3><span>${escapeHtml(group.name)}</span><span>${count}</span></h3>`;
    const grid = document.createElement("div");
    grid.className = "card-grid";
    group.cards.forEach((c) => grid.appendChild(cardTile(c, c.qty || 1)));
    wrap.appendChild(grid);
    groupsEl.appendChild(wrap);
  }

  renderCurve(deck);

  el("deck-panel").classList.remove("hidden");
  window._lastDeck = deck; // for copy-to-clipboard
}

// Renders an actual card image (not a text row) for every card, including basic lands
// once their art has been fetched in buildDeck's balancing step.
function cardTile(card, qty) {
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
  tile.addEventListener("mouseenter", (e) => showPreview(card, e));
  tile.addEventListener("mousemove", positionPreview);
  tile.addEventListener("mouseleave", hidePreview);
  return tile;
}

function missingArtLabel(name) {
  const label = document.createElement("div");
  label.className = "art-missing";
  label.textContent = name;
  return label;
}

let previewEl = null;
function showPreview(card, e) {
  const art = cardArt(card, "normal") || cardArt(card, "small");
  if (!art) return;
  if (!previewEl) {
    previewEl = document.createElement("img");
    previewEl.className = "card-preview";
    document.body.appendChild(previewEl);
  }
  previewEl.src = art;
  previewEl.style.display = "block";
  positionPreview(e);
}
function positionPreview(e) {
  if (!previewEl) return;
  const x = Math.min(e.clientX + 20, window.innerWidth - 260);
  const y = Math.min(e.clientY + 20, window.innerHeight - 340);
  previewEl.style.left = x + "px";
  previewEl.style.top = y + "px";
}
function hidePreview() {
  if (previewEl) previewEl.style.display = "none";
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

el("copy-btn").addEventListener("click", async () => {
  const deck = window._lastDeck;
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
