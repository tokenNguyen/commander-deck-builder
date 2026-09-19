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

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "commander-deck-builder (personal project)" },
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

// The most-viewed public Commander decks on Archidekt for one commander.
async function archidekt(params) {
  const commander = (params.get("commander") || "").trim();
  if (!commander || commander.length > 200) return { status: 400, body: { error: "bad commander" } };

  const url = `https://archidekt.com/api/decks/v3/?commanderName=${encodeURIComponent(commander)}&formats=3&orderBy=-viewCount`;
  const data = await getJson(url);

  const decks = (data.results || [])
    .filter((d) => !d.private && !d.unlisted && Number.isInteger(d.id))
    .slice(0, 5)
    .map((d) => ({
      id: d.id,
      name: String(d.name || "").slice(0, 120),
      owner: (d.owner && d.owner.username) || "",
      views: d.viewCount || 0,
      bracket: d.edhBracket == null ? null : d.edhBracket,
      url: `https://archidekt.com/decks/${d.id}`,
    }));
  return { status: 200, body: { decks }, cache: 6 * 3600 };
}

const TARGETS = { spellbook, archidekt };

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "GET only" });
  }
  const params = new URL(req.url, "http://localhost").searchParams;
  const target = params.get("target");
  if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) return send(res, 400, { error: "unknown target" });

  try {
    const result = await TARGETS[target](params);
    send(res, result.status, result.body, result.cache);
  } catch (err) {
    send(res, 502, { error: "upstream unavailable" });
  }
};
