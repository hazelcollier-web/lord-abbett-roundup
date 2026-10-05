// Weekly headline scan for the Lord Abbett worksheet.
// For each site x search, pulls the past week's results from Google News
// (filtered to that site), scores headlines by the worksheet's keywords,
// and returns the top 6.

const SITES = {
  bbg: { name: "Bloomberg", domain: "bloomberg.com" },
  ft: { name: "Financial Times", domain: "ft.com" },
  wsj: { name: "Wall Street Journal", domain: "wsj.com" },
  nyt: { name: "New York Times", domain: "nytimes.com" },
};

const SEARCHES = {
  am: {
    phrase: "asset management",
    words: [
      "acquire", "acquisition", "buy", "buys", "sale", "sell", "sells", "deal", "merger", "stake", "takeover",
      "AUM", "assets under management", "inflow", "outflow", "redemption", "withdrawal",
      "BlackRock", "Vanguard", "Pimco", "Franklin", "Blackstone", "KKR", "Apollo", "Blue Owl",
      "consolidation", "scale", "fee cut", "private markets", "private credit", "wealth management",
    ],
  },
  mf: {
    phrase: "mutual funds",
    words: [
      "active", "passive", "stock-picking", "stockpicking", "benchmark", "Morningstar",
      "ETF", "launch", "conversion", "share class",
      "flow", "outflow", "fee", "interval fund", "retail investor", "401(k)", "target-date",
      "SEC", "rule", "disclosure",
    ],
  },
  cm: {
    phrase: "capital markets",
    words: [
      "Treasury", "Treasuries", "yield", "10-year", "30-year", "bond selloff", "Fed", "rate hike", "rate cut", "Warsh", "buyback",
      "spread", "high yield", "high-yield", "junk", "leveraged loan", "private credit", "default", "bond sale", "issuance",
      "municipal", "muni", "IPO", "listing", "record deal",
    ],
  },
};

const KEEPERS = [
  "record", "biggest", "largest", "first since", "highest since", "lowest since", "curbs", "halts", "limits", "warns",
];
const MONEY = /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:bn|billion|trillion|tn|mn|million)\b/i;

const TOP_N = 6;

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Match a word or phrase, allowing a plural ending, without matching inside other words.
function wordRe(w) {
  return new RegExp("(?<![A-Za-z0-9])" + esc(w) + "(?:s|es)?(?![A-Za-z0-9])", "i");
}
const COMPILED = {};
for (const [k, s] of Object.entries(SEARCHES)) COMPILED[k] = s.words.map(wordRe);
const KEEPER_RES = KEEPERS.map(wordRe);

function score(title, key) {
  let pts = 0;
  for (const re of COMPILED[key]) if (re.test(title)) pts += 1;
  for (const re of KEEPER_RES) if (re.test(title)) pts += 2;
  if (MONEY.test(title)) pts += 2;
  return pts;
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]) : "";
}

function parseRss(xml, siteName) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    let title = tag(b, "title");
    const link = tag(b, "link");
    const pub = tag(b, "pubDate");
    const source = tag(b, "source");
    // Google News appends " - Outlet" to every title; strip it.
    const suffixes = [source, siteName].filter(Boolean);
    for (const s of suffixes) {
      const tail = " - " + s;
      if (title.endsWith(tail)) { title = title.slice(0, -tail.length).trim(); break; }
    }
    title = title.replace(/\s+-\s+(Bloomberg(?:\.com)?|Financial Times|FT|WSJ|The Wall Street Journal|The New York Times|NYTimes\.com)$/i, "").trim();
    if (!title || !link) continue;
    items.push({ title, link, date: pub ? new Date(pub).toISOString() : null });
  }
  return items;
}

function rank(items, key) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const seen = new Set();
  return items
    .filter(it => !it.date || new Date(it.date).getTime() >= weekAgo)
    .filter(it => { const k = it.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(it => ({ ...it, score: score(it.title, key) }))
    .sort((a, b) => b.score - a.score || (b.date || "").localeCompare(a.date || ""))
    .slice(0, TOP_N);
}

async function fetchSearch(siteKey, searchKey) {
  const site = SITES[siteKey], search = SEARCHES[searchKey];
  const q = '"' + search.phrase + '" site:' + site.domain + " when:7d";
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LaurelRoundup/1.0)" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const xml = await r.text();
    return { ok: true, items: rank(parseRss(xml, site.name), searchKey) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function handler(req, res) {
  const jobs = [];
  for (const s of Object.keys(SITES)) for (const k of Object.keys(SEARCHES)) {
    jobs.push(fetchSearch(s, k).then(r => [s + "-" + k, r]));
  }
  const results = Object.fromEntries(await Promise.all(jobs));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(JSON.stringify({ generated: new Date().toISOString(), results }));
}

module.exports = handler;
module.exports._test = { parseRss, rank, score };
