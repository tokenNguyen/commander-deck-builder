// Vercel serverless function: a narrow proxy for sites that block direct browser access (CORS).
// It never accepts a URL from the caller. Each `target` builds its own fixed upstream URL from
// validated parameters, so this can't be used as an open proxy.

const UPSTREAM_TIMEOUT_MS = 8000;
const COLOR_RE = /^[WUBRG]{0,5}$/;

function send(res, status, body, cacheSeconds) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    cacheSeconds ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=86400` : "no-store"
  );
  res.end(JSON.stringify(body));
}

async function getJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json", "User-Agent": "commander-deck-builder (personal project)" };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Combos that include one card, limited to Commander-legal combos inside the deck's colors.
// Combos that need a generic stand-in piece ("any creature") are skipped: whether a deck
// satisfies those can't be judged from card names alone.
async function spellbook(params) {
  const card = (params.get("card") || "").trim();
  const ci = (params.get("ci") || "").toUpperCase();
  if (!card || card.length > 200 || card.includes('"')) return { status: 400, body: { error: "bad card" } };
  if (!COLOR_RE.test(ci)) return { status: 400, body: { error: "bad ci" } };

  const identity = ci ? `ci<=${ci}` : "ci=C";
  const q = `card:"${card}" legal:commander ${identity}`;
  const url = `https://backend.commanderspellbook.com/variants/?q=${encodeURIComponent(q)}&ordering=-popularity&limit=40`;
  const data = await getJson(url);

  const combos = (data.results || [])
    .filter((v) => !(v.requires && v.requires.length))
    .map((v) => ({
      id: v.id,
      cards: (v.uses || []).map((u) => u.card && u.card.name).filter(Boolean),
      produces: (v.produces || []).map((p) => p.feature && p.feature.name).filter(Boolean).slice(0, 6),
      popularity: v.popularity || 0,
    }));
  return { status: 200, body: { combos }, cache: 6 * 3600 };
}

// Two-card combos that are actually inside a whole decklist, for the bracket estimate.
// Commander Spellbook rates each combo (Ruthless = fast and cheap, then Spicy, Powerful, ...).
// Combos needing a generic stand-in piece ("any creature") are skipped, as in `spellbook`.
async function spellbookBracket(body) {
  const commander = body && typeof body.commander === "string" ? body.commander.trim() : "";
  const cards = body && Array.isArray(body.cards) ? body.cards : null;
  const valid = (n) => typeof n === "string" && n.trim() && n.length <= 200;
  if (!commander || commander.length > 200 || !cards || cards.length > 150 || !cards.every(valid)) {
    return { status: 400, body: { error: "bad deck" } };
  }
  const data = await getJson("https://backend.commanderspellbook.com/estimate-bracket", {
    main: cards.map((card) => ({ card: card.trim(), quantity: 1 })),
    commanders: [{ card: commander, quantity: 1 }],
  });
  const combos = (data.combos || [])
    .map((entry) => entry.combo)
    .filter((c) => c && !(c.requires && c.requires.length))
    .map((c) => ({
      cards: (c.uses || []).map((u) => u.card && u.card.name).filter(Boolean),
      produces: (c.produces || []).map((p) => p.feature && p.feature.name).filter(Boolean).slice(0, 6),
      bracketTag: typeof c.bracketTag === "string" ? c.bracketTag : "",
    }))
    .filter((c) => c.cards.length)
    .slice(0, 40);
  return { status: 200, body: { combos } };
}

const TARGETS = { spellbook };
const POST_TARGETS = { "spellbook-bracket": spellbookBracket };

const MAX_BODY_BYTES = 64 * 1024;
// Vercel hands over a parsed req.body for JSON requests; a plain Node server does not.
async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return null;
    if (typeof req.body === "object") return req.body;
    try { return JSON.parse(String(req.body)); } catch { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

module.exports = async function handler(req, res) {
  const isPost = req.method === "POST";
  if (req.method !== "GET" && !isPost) {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "GET or POST only" });
  }
  const params = new URL(req.url, "http://localhost").searchParams;
  const target = params.get("target");
  const table = isPost ? POST_TARGETS : TARGETS;
  if (!Object.prototype.hasOwnProperty.call(table, target)) return send(res, 400, { error: "unknown target" });

  try {
    const result = isPost ? await table[target](await readJson(req)) : await table[target](params);
    send(res, result.status, result.body, result.cache);
  } catch (err) {
    send(res, 502, { error: "upstream unavailable" });
  }
};
