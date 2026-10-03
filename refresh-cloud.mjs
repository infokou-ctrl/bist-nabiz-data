// Cloud-friendly data refresh — runs anywhere (GitHub Actions), NO Borsa_MCP.
// Pulls BIST snapshots + 1y daily history from Yahoo Finance and computes all
// indicators locally. Slow-moving datasets (details/news/macro/inflation) are
// PRESERVED from the existing snapshot, since they don't change intraday.
//
// Produces the same public/data/*.json schema the app already reads.
// Run: node scripts/refresh-cloud.mjs

import YahooFinance from "yahoo-finance2";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFundamentals } from "./lib/quality.mjs";
import { evdsSeries, EVDS_CODES, EVDS_MACRO_CANDIDATES, yoyPct } from "./lib/evds.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const round = (x, n) => {
  if (x == null || !isFinite(x)) return null;
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
};
// Yahoo dates come as Date objects (or epoch seconds / {raw}); -> "YYYY-MM-DD" or null.
const isoDate = (v) => {
  if (v == null) return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") d = new Date(v * (v < 1e12 ? 1000 : 1));
  else if (typeof v === "object" && v.raw != null) d = new Date(v.raw * 1000);
  else d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const readJson = async (name, fallback) => {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
};

// ---- indicators ----------------------------------------------------------
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function rsiWilder(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
function macd(closes) {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  if (!e26.length) return null;
  const line = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const compact = line.filter((v) => v != null);
  const sig = ema(compact, 9);
  const m = line[line.length - 1];
  if (m == null || sig == null) return null;
  return { macd: m, signal: sig, hist: m - sig };
}
function pivots(h, l, c) {
  const pp = (h + l + c) / 3;
  return {
    pp, r1: 2 * pp - l, s1: 2 * pp - h, r2: pp + (h - l), s2: pp - (h - l),
    r3: h + 2 * (pp - l), s3: l - 2 * (h - pp),
  };
}
// Keep daily bars for the last ~1y (detail for short-range views); collapse older
// bars to one-per-week (the last trading day of each ISO week) for the long view.
function downsampleHistory(rows) {
  if (rows.length < 2) return rows;
  const cutoff = new Date(Date.now() - 366 * 864e5);
  const weekKey = (d) => {
    // Thursday-based ISO week bucket, good enough for a "one bar per week" pick.
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const wk = Math.ceil(((t - yStart) / 864e5 + 1) / 7);
    return t.getUTCFullYear() + "-" + wk;
  };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.date >= cutoff) { out.push(r); continue; }
    const next = rows[i + 1];
    // keep the last bar of each week (next bar is a new week, in a new week, or is recent)
    if (!next || next.date >= cutoff || weekKey(next.date) !== weekKey(r.date)) out.push(r);
  }
  return out;
}

function trendFrom(price, e20, e50) {
  if (e20 == null || e50 == null) return "yatay";
  if (price > e20 && e20 >= e50) return "yükseliş";
  if (price < e20 && e20 <= e50) return "düşüş";
  return "yatay";
}
const SECTOR_TR = {
  "Financial Services": "Finans", "Technology": "Teknoloji", "Industrials": "Sanayi",
  "Consumer Cyclical": "Tüketici (Döngüsel)", "Consumer Defensive": "Tüketici (Savunmacı)",
  "Energy": "Enerji", "Basic Materials": "Temel Malzeme", "Healthcare": "Sağlık",
  "Utilities": "Kamu Hizmetleri", "Real Estate": "Gayrimenkul", "Communication Services": "İletişim",
};
// Per-symbol overrides: Yahoo files the listed football clubs under
// "Communication Services" (media/broadcast revenue), which reads wrong on the
// panel — they are sports clubs. Force them into a dedicated "Spor" sector.
const SECTOR_SYMBOL = {
  "GSRAY": "Spor", "FENER": "Spor", "BJKAS": "Spor", "TSPOR": "Spor",
};
function mapSector(s, sym) {
  if (sym && SECTOR_SYMBOL[sym]) return SECTOR_SYMBOL[sym];
  return s ? (SECTOR_TR[s] || s) : null;
}

function sma(closes, n) {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}
function stdev(closes, n) {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  const m = slice.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / n);
}
// Recent SMA50/SMA200 crossover within last ~12 bars: "golden" | "death" | null.
function detectCross(closes) {
  if (closes.length < 212) return null;
  const smaAt = (end, n) => {
    let s = 0;
    for (let i = end - n + 1; i <= end; i++) s += closes[i];
    return s / n;
  };
  let prevSign = null;
  for (let k = 12; k >= 0; k--) {
    const end = closes.length - 1 - k;
    const sign = smaAt(end, 50) - smaAt(end, 200) >= 0 ? 1 : -1;
    if (prevSign != null && sign !== prevSign) return sign > 0 ? "golden" : "death";
    prevSign = sign;
  }
  return null;
}

// ---- KAP disclosures (news) ----------------------------------------------
// Working endpoint captured from the live SPA: POST /tr/api/disclosure/members/byCriteria
// returns ALL "İşlem Gören Şirket" (IGS) disclosures in a date range, no cookies needed.
// Each item: {disclosureIndex, stockCodes:"AAA, BBB", subject, summary, publishDate:"DD.MM.YYYY HH:MM:SS"}.
const KAP_API = "https://www.kap.org.tr/tr/api/disclosure/members/byCriteria";
const KAP_DISCLOSURE_URL = (idx) => "https://www.kap.org.tr/tr/Bildirim/" + idx;

function kapDateToIso(s) {
  // "08.09.2026 16:35:59" -> "2026-09-08"
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s || "");
  return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
}

async function fetchNews(symbols, prevNews) {
  const wanted = new Set(symbols);
  const to = new Date();
  // 7-day window: the API caps responses at ~2000 items (newest-first); 7 days
  // stays comfortably under that so every BIST symbol's recent disclosures survive.
  const from = new Date(Date.now() - 7 * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const body = {
    fromDate: fmt(from), toDate: fmt(to), memberType: "IGS",
    mkkMemberOidList: [], inactiveMkkMemberOidList: [], disclosureClass: "",
    subjectList: [], isLate: "", mainSector: "", sector: "", subSector: "",
    marketOid: "", index: "", bdkReview: "", bdkMemberOidList: [], year: "",
    term: "", ruleType: "", period: "", fromSrc: false, srcCategory: "",
    disclosureIndexList: [],
  };
  let arr;
  try {
    const r = await fetch(KAP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "tr" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    arr = await r.json();
    if (!Array.isArray(arr)) throw new Error("beklenmeyen yanıt");
  } catch (e) {
    console.log("  KAP news fetch failed (" + e.message + ") — mevcut news.json korunuyor");
    return prevNews || {};
  }

  // Accumulate: start from the previously-stored history and MERGE new disclosures
  // in (dedupe by url), so the archive grows day by day instead of being replaced.
  const PER_SYMBOL_CAP = 40;
  const out = {};
  for (const [sym, items] of Object.entries(prevNews || {})) {
    if (wanted.has(sym) && Array.isArray(items)) out[sym] = items.slice();
  }
  const seen = {}; // sym -> Set of urls already present
  for (const sym of Object.keys(out)) {
    seen[sym] = new Set(out[sym].map((n) => n.url).filter(Boolean));
  }

  // API is newest-first.
  for (const d of arr) {
    const codes = String(d.stockCodes || "")
      .split(",").map((c) => c.trim()).filter(Boolean);
    if (!codes.length) continue;
    const date = kapDateToIso(d.publishDate);
    const url = d.disclosureIndex != null ? KAP_DISCLOSURE_URL(d.disclosureIndex) : null;
    const subject = (d.subject || "").trim();
    const summary = (d.summary || "").trim();
    // title: specific summary preferred, fall back to the subject/category.
    let title = summary || subject;
    if (summary && subject && summary.toLowerCase() !== subject.toLowerCase()) {
      title = subject + " — " + summary;
    }
    if (!title) continue;
    for (const code of codes) {
      if (!wanted.has(code)) continue;
      (out[code] ||= []);
      (seen[code] ||= new Set());
      if (url && seen[code].has(url)) continue; // already archived
      if (url) seen[code].add(url);
      // Keep the official KAP summary separately (clean disclosure text) so the
      // in-app news view can show a real paragraph, not just the headline.
      const sum = summary && summary.toLowerCase() !== subject.toLowerCase() ? summary : "";
      out[code].push({ title, date, url, summary: sum || null });
    }
  }

  // Newest-first, then cap the archive per symbol.
  for (const sym of Object.keys(out)) {
    out[sym].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (out[sym].length > PER_SYMBOL_CAP) out[sym] = out[sym].slice(0, PER_SYMBOL_CAP);
  }
  return out;
}

// ---- market news (basından — Google News RSS) ----------------------------
// KAP = resmi bildirimler; bu ise gazetecilik/piyasa haberleri (ör. "X'i Y'ye
// sattı" gibi haberler KAP'ta olmaz). Şirket adına göre Google News RSS'ten
// çekilir. 100 istek pahalı olduğu için CI'da SAATTE BİR çalışır (dk<15).
function cleanCompanyName(name) {
  return String(name || "")
    .replace(/\([^)]*\)/g, " ")      // "İŞ BANKASI (C)" -> "İŞ BANKASI"
    .replace(/\bA\.?Ş\.?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n] ?? m);
}
// Named entities Turkish outlets actually emit in descriptions / paragraphs.
const NAMED_ENTITIES = {
  nbsp: " ", ccedil: "ç", Ccedil: "Ç", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", ndash: "–", mdash: "—", laquo: "«", raquo: "»",
};

// ---- trusted sources (2026-10-04) --------------------------------------------
// The owner asked that news come only from reliable outlets. Google News mixes in
// hundreds of small blogs and local papers (227 sources in 1.244 items, measured);
// only these are kept: news agencies, national media, established business press.
// Matched on the publisher's host (RSS <source url> for new items, the resolved
// `pub` URL for archived ones). Edit this list to add/remove an outlet.
const TRUSTED_NEWS = [
  // haber ajansları
  "aa.com.tr", "iha.com.tr", "dha.com.tr", "ankahaber.net", "hibya.com",
  // ulusal yayın kuruluşları
  "hurriyet.com.tr", "milliyet.com.tr", "sabah.com.tr", "sozcu.com.tr", "haberturk.com", "ntv.com.tr", "cnnturk.com",
  "trthaber.com", "t24.com.tr", "cumhuriyet.com.tr", "yenisafak.com", "karar.com", "bbc.com", "dw.com", "reuters.com",
  "independentturkish.com", "mynet.com",
  // ekonomi / finans yayınları
  "dunya.com", "ekonomim.com", "bloomberght.com", "businessht.com.tr", "ekonomigazetesi.com", "investing.com", "cnbce.com",
  "forbes.com.tr", "fortuneturkey.com", "patronlardunyasi.com", "foreks.com", "paraanaliz.com", "borsagundem.com.tr",
  "paratic.com", "ekoturk.com", "doviz.com", "matriksdata.com", "ekonomist.com.tr", "capital.com.tr", "tradingview.com",
];
function isTrustedUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return TRUSTED_NEWS.some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}
// Archived items carry the resolved publisher URL; fresh RSS items the outlet's home page.
const isTrustedItem = (it) => isTrustedUrl(it.pub || it.site || "");

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">"));
      return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : "";
    };
    let title = pick("title");
    const source = pick("source");
    const site = (b.match(/<source[^>]*\burl="([^"]+)"/) || [])[1] || null; // the outlet's home page
    const link = pick("link");
    const pub = pick("pubDate");
    // Google News titles are "Headline - Source"; drop the trailing source.
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    // Description → a plain-text snippet (strip HTML). Google News search feeds
    // often put only related links here, so keep it only when it's real prose
    // that isn't just the headline again.
    const descRaw = pick("description");
    let summary = descRaw
      ? descRaw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
      : "";
    if (summary && (summary.length < 40 || isEchoSummary(summary, title, source))) summary = "";
    if (summary.length > 500) summary = summary.slice(0, 497).trim() + "…";
    // Keep the full publish timestamp (ISO) so the UI can show the news TIME.
    let date = null;
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) date = d.toISOString(); }
    if (!title || title === "Google Haberler" || !link) continue;
    items.push({ title, date, url: link, source: source || null, site, summary: summary || null });
  }
  return items;
}

// Is this headline actually about THIS company?
//
// Two ways to qualify: the headline names the company (or its spaceless brand
// form), or it carries the ticker AS WRITTEN IN THE FINANCIAL PRESS — i.e. in
// caps — together with a finance word. The ticker test used to be
// case-insensitive with no context requirement, which filed "Mescid-i Aksa"
// under AKSA; ordinary proper nouns collide with three- and four-letter tickers
// constantly, so a bare ticker match is not evidence on its own.
// Words that mark a headline as being about a COMPANY (markets or operations),
// used to qualify weak identifiers.
//
// Deliberately phrase-based, not single short stems. JavaScript's \b is
// ASCII-only, so Turkish letters do NOT count as word characters: /\bkar\b/
// happily matches "karşı" (ş is a non-word char to the engine) and /\balım\b/
// matches nothing useful while /alım/ matched "Alimleri". Both mistakes filed
// Gaza headlines under AKSA. Keep tokens long or anchored in a phrase.
const COMPANY_CTX = new RegExp(
  [
    "hisse", "borsa", "\\bbist\\b", "sermaye", "bilan[çc]o", "temett[üu]",
    "net k[âa]r", "k[âa]r pay", "zarar", "yat[ıi]r[ıi]m", "halka arz", "halka a[çc][ıi]l",
    "s[öo]zle[şs]me", "ihale", "sat[ıi][şs]", "sat[ıi]n al", "pay al", "pay sat",
    "geri al[ıi]m", "blok al[ıi]m", "endeks", "piyasa", "\\bfon\\b", "[üu]retim",
    "fabrika", "tesis", "ihracat", "rafineri", "kapasite", "\\bceo\\b",
    "genel m[üu]d[üu]r", "y[öo]netim kurulu", "\\bkap\\b", "birle[şs]me",
    "\\bmarka", "\\bkota", "bedelsiz", "sermaye art",
  ].join("|"),
  "i",
);

function makeRelevance(stock) {
  const name = cleanCompanyName(stock.name);
  const ns = name.replace(/\s+/g, "");
  const norm = (x) => x.toLocaleLowerCase("tr").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const nName = norm(name), nNs = norm(ns);
  const tickerRe = new RegExp("\\b" + stock.symbol + "\\b"); // case-SENSITIVE
  // A one-word company name carries no more information than the ticker — for
  // AKSA the stored name IS "AKSA", so matching it case-insensitively filed
  // every "Mescid-i Aksa" headline under the stock. Weak identifiers have to be
  // backed by a company-context word; multi-word names are specific enough.
  const weakName = nName.split(/\s+/).filter(Boolean).length < 2;
  return (title) => {
    const raw = title || "";
    const t = norm(raw);
    const ctx = COMPANY_CTX.test(raw);
    const byName = (nName.length >= 4 && t.includes(nName)) ||
      (nNs !== nName && nNs.length >= 4 && t.includes(nNs));
    if (byName) return weakName ? ctx : true;
    return tickerRe.test(raw) && ctx;
  };
}

// Content-free / mirror headlines add noise, not signal. KAP mirror posts
// ("KAP *** X A.Ş. *** SYM *** ...") duplicate the official KAP feed shown right
// above; aggregator stubs ("... - KAP Haberleri - 2026-09-10 tarihli") say
// nothing. Drop both from the PRESS feed.
function isJunkNews(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (/\bKAP\b\s*\*\*\*/i.test(t)) return true;
  if (/KAP\s*Haberleri/i.test(t)) return true;
  if (/tarihli\s*$/i.test(t)) return true;
  if (/^\s*\*{2,}/.test(t)) return true;
  // Quote / chart / forum / comment pages, not news ("AKBANK Hisse Senedi Canlı
  // Grafik", "VAKBN Hisse Yorumları", "… Forumu", "(GUBRF) Hisse Senedi").
  if (/hisse senedi\s*(canlı grafik)?\s*$|canlı grafik|hisse yorumları|güncel yorumlar|forumu?\b|tradingview görüşleri|\)\s*hisse senedi\s*$/i.test(t)) return true;
  return false;
}
function cleanMarketTitle(title) {
  return String(title || "")
    .replace(/\s*\*{2,}\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchMarketNews(stocks, prev) {
  const prevItems = (prev && prev.items) || {};
  // Gate: only run when the CI wall-clock is in the first quarter-hour (≈ hourly),
  // to avoid 100 Google requests every 15 min. Local manual runs (FORCE) bypass.
  const force = process.env.FORCE_NEWS === "1";
  if (!force && new Date().getUTCMinutes() >= 15) {
    return { updatedAt: (prev && prev.updatedAt) || null, items: prevItems, skipped: true };
  }
  const relevanceBySym = {};
  for (const s of stocks) relevanceBySym[s.symbol] = makeRelevance(s);

  // Re-check the stored archive against the CURRENT filter, so tightening it
  // also cleans out items an earlier, looser version let through.
  const out = {};
  let purged = 0;
  for (const [sym, items] of Object.entries(prevItems)) {
    const rel = relevanceBySym[sym];
    if (!rel) { out[sym] = items.slice(); continue; }
    out[sym] = items.filter((n) => rel(n.title || "") && !isJunkNews(n.title || "") && isTrustedItem(n))
      .map((n) => ({ ...n, title: cleanMarketTitle(n.title || "") }));
    purged += items.length - out[sym].length;
  }
  if (purged) console.log("  arşivden elenen alakasız haber: " + purged);
  const seen = {};
  for (const sym of Object.keys(out)) seen[sym] = new Set(out[sym].map((n) => (n.title || "").toLowerCase()));

  let done = 0;
  for (const s of stocks) {
    done++;
    const name = cleanCompanyName(s.name);
    if (!name || name.length < 3) continue;
    process.stdout.write("\rMarket news " + done + "/" + stocks.length + " (" + s.symbol + ")     ");
    // Precise query: exact name (+ spaceless brand variant, e.g. "ŞİŞE CAM"→"ŞİŞECAM")
    // anchored to a finance context so generic word-matches (bottle/glass) are excluded.
    const ns = name.replace(/\s+/g, "");
    const nameClause = ns !== name ? '("' + name + '" OR "' + ns + '")' : '"' + name + '"';
    const query = nameClause + " (borsa OR hisse OR BIST OR " + s.symbol + " OR şirket) when:10d";
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=tr&gl=TR&ceid=TR:tr";
    const relevant = relevanceBySym[s.symbol] || (() => false);
    try {
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = parseRssItems(xml);
      (out[s.symbol] ||= []);
      (seen[s.symbol] ||= new Set());
      for (const it of items) {
        if (!relevant(it.title || "")) continue; // company-specific only
        if (!isTrustedItem(it)) continue;        // reliable outlets only
        if (isJunkNews(it.title)) continue;      // drop KAP mirrors / stubs
        it.title = cleanMarketTitle(it.title);
        const key = (it.title || "").toLowerCase();
        if (!key || seen[s.symbol].has(key)) continue;
        seen[s.symbol].add(key);
        out[s.symbol].push(it);
      }
      out[s.symbol].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      if (out[s.symbol].length > 20) out[s.symbol] = out[s.symbol].slice(0, 20);
    } catch { /* skip this symbol, keep prior */ }
    await new Promise((res) => setTimeout(res, 120));
  }
  process.stdout.write("\n");
  return { updatedAt: new Date().toISOString(), items: out };
}

// ---- article summary --------------------------------------------------------
//
// For each news item without a real summary: resolve the Google News link to the
// publisher's page, then take the PUBLISHER'S OWN short description of the story
// (og:description / meta description — what the outlet wrote for link previews).
// If that is missing or is the site's generic blurb, fall back to the article's
// opening paragraphs as written. No LLM, no key, nothing invented; every summary
// is the outlet's text, shown with its name and a link. Best-effort: bot walls /
// paywalls / JS-only pages yield nothing and the app says "özet alınamadı".
//
// Measured 2026-10-01: all 1.211 archived items carried only "headline + source"
// as their summary (Google's <description>), and the old code refused to follow
// Google links — so the app never had a single real summary.
const SUMMARY_MAX_PER_RUN = Number(process.env.SUMMARY_CAP) || 120; // CI: modest; local backfill sets SUMMARY_CAP
const SUMMARY_CONCURRENCY = 4;
const SUMMARY_TIMEOUT_MS = 9000;
const SUMMARY_MAX_CHARS = 1200;  // the article's opening incl. its list/table — enough to read the news, not the whole article
const SUMMARY_VERSION = 3;        // bump to re-process stored summaries with improved rules
const SUMMARY_MAX_TRIES = 2;      // a page that failed twice is not retried every hour
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const normText = (x) => String(x || "").toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

// Google News puts "Headline  Source" into <description>. That is not a summary.
function isEchoSummary(summary, title, source) {
  let rest = normText(summary);
  if (!rest) return true;
  for (const part of [normText(title), normText(source)]) if (part) rest = rest.split(part).join(" ");
  return rest.replace(/\s+/g, " ").trim().length < 25;
}

// Does this text talk about the same thing as the headline? Guards against a
// site-wide blurb ("X Dergisi haberleri, tüm Türkiye'den…") or a scraped menu.
function sharesTopic(text, title) {
  const words = new Set(normText(title).split(" ").filter((w) => w.length >= 4));
  if (!words.size) return true;
  const t = " " + normText(text) + " ";
  let hit = 0;
  for (const w of words) if (t.includes(" " + w.slice(0, 5))) hit++; // 5-letter stem: Turkish suffixes vary
  return hit >= Math.min(2, words.size);
}

function extractParagraphs(html) {
  let h = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const art = h.match(/<article[\s\S]*?<\/article>/i);
  const scope = art ? art[0] : h;
  // Boilerplate a <p> scrape picks up on JS-rendered shells (Google News, KAP
  // SPA, generic nav/consent). If we can't get REAL prose we return nothing.
  const JUNK = /tüm kategoriler|aşağıdaki öneriler|özel durum açıklaması\s+finansal rapor|fon bildirimleri|çerez|cookie|abone ol|reklam|tüm hakları|giriş yap|kayıt ol|menü|javascript|tarayıcınız|takip et|linki kopyala|tercih edilen kaynak|haber giriş|yazdır|ilgili haberler|etiketler|paylaş/i;
  const txt = (x) => decodeEntities(decodeEntities(String(x).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))).replace(/\s+/g, " ").trim();
  const ps = [];
  let started = !!art; // list items / table rows only once real content has begun (not nav menus)
  // Paragraphs, list items and table rows in document order — a "15 hisse için
  // hedef fiyat" story keeps its actual list, not just the intro sentence.
  const seenLine = new Set();
  const add = (line) => { if (!seenLine.has(line)) { seenLine.add(line); ps.push(line); } }; // repeated table headers once
  for (const m of scope.matchAll(/<(p|li|tr|h2|h3|h4)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    if (tag[0] === "h") {
      // Sub-headings name what the next list/table is about ("ASELS — Aselsan").
      const t = txt(m[2]);
      if (started && t.length >= 3 && t.length <= 100 && !JUNK.test(t)) add("• ▸ " + t);
      continue;
    }
    if (tag === "p") {
      const t = txt(m[2]);
      if (t.length < 60 || !/[.!?…]/.test(t) || JUNK.test(t)) continue;
      // Prose has plenty of lowercase; a run of Capitalised category labels does not.
      const lower = (t.match(/[a-zçğıöşü]/g) || []).length;
      if (lower / t.length < 0.5) continue;
      ps.push(t); started = true;
    } else if (!started) {
      continue;
    } else if (tag === "li") {
      const t = txt(m[2]);
      // Menu-like items are short link text; real list items carry content.
      if (t.length < 12 || t.length > 300 || JUNK.test(t) || (/<a\b/i.test(m[2]) && t.length < 40)) continue;
      add("• " + t);
    } else {
      const cells = [...m[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => txt(c[1])).filter(Boolean);
      if (cells.length < 2 || cells.some((c) => c.length > 80)) continue;
      add("• " + cells.join(" · "));
    }
  }
  return ps;
}

function summariseParagraphs(ps) {
  let out = "";
  let prevList = false;
  for (const p of ps) {
    const isList = p.startsWith("• ");
    const sep = !out ? "" : isList && prevList ? "\n" : "\n\n";
    if (out && (out.length + sep.length + p.length) > SUMMARY_MAX_CHARS) break;
    out += sep + p;
    prevList = isList;
    if (out.length >= SUMMARY_MAX_CHARS) break;
  }
  return clip(out);
}

// Cut at the last sentence end inside the limit; otherwise at a word, with "…".
function clip(text) {
  let out = String(text || "").trim();
  if (out.length <= SUMMARY_MAX_CHARS) return out;
  out = out.slice(0, SUMMARY_MAX_CHARS);
  const end = Math.max(out.lastIndexOf(". "), out.lastIndexOf("! "), out.lastIndexOf("? "));
  if (end >= SUMMARY_MAX_CHARS * 0.5) return out.slice(0, end + 1).trim();
  return out.slice(0, out.lastIndexOf(" ")).trim() + "…";
}

// The outlet's own description of the story, from the page head.
function metaDescription(html) {
  const res = [
    /<meta[^>]+property=["']og:description["'][^>]*content="([^"]+)"/i,
    /<meta[^>]+property=["']og:description["'][^>]*content='([^']+)'/i,
    /<meta[^>]+content="([^"]+)"[^>]*property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]*content="([^"]+)"/i,
    /<meta[^>]+name=["']description["'][^>]*content='([^']+)'/i,
    /<meta[^>]+content="([^"]+)"[^>]*name=["']description["']/i,
  ];
  for (const re of res) {
    const m = re.exec(html);
    if (!m) continue;
    let t = decodeEntities(decodeEntities(m[1])).replace(/\s+/g, " ").trim();
    if (t.length < 80) continue;
    // Outlets truncate these mid-word at a fixed length; mark the cut honestly.
    if (!/[.!?…"”')]$/.test(t)) t = t.replace(/\.{2,}$/, "").trim() + "…";
    return t;
  }
  return "";
}

// Google News RSS links are opaque. The article page carries a signature and a
// timestamp that Google's own redirect endpoint exchanges for the publisher URL.
// Fragile by nature (undocumented), so: one failure = no summary for that item,
// and a 429 trips a breaker that stops resolving for the rest of the run.
let googleBlocked = false;
async function resolveGoogleNewsUrl(url) {
  if (googleBlocked) return null;
  try {
    const id = new URL(url).pathname.split("/").pop();
    if (!id) return null;
    const sig = AbortSignal.timeout ? AbortSignal.timeout(SUMMARY_TIMEOUT_MS) : undefined;
    const r = await fetch("https://news.google.com/rss/articles/" + id, { headers: { "User-Agent": BROWSER_UA }, signal: sig });
    if (r.status === 429) { googleBlocked = true; return null; }
    if (!r.ok) return null;
    const html = await r.text();
    const sg = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
    const ts = /data-n-a-ts="([^"]+)"/.exec(html)?.[1];
    if (!sg || !ts) return null;
    const inner = ["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg];
    const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", JSON.stringify(inner), null, "generic"]]]));
    const sig2 = AbortSignal.timeout ? AbortSignal.timeout(SUMMARY_TIMEOUT_MS) : undefined;
    const r2 = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": BROWSER_UA },
      body, signal: sig2,
    });
    if (r2.status === 429) { googleBlocked = true; return null; }
    if (!r2.ok) return null;
    const m = /\[\\"garturlres\\",\\"([^"\\]+)/.exec(await r2.text());
    if (!m) return null;
    const out = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
    return /^https?:\/\//.test(out) && !/(^|\.)google\.com$/.test(new URL(out).hostname) ? out : null;
  } catch {
    return null;
  }
}

// Teaser tails outlets append to descriptions ("İşte detaylar;…"). Cut, not shown.
const TEASER = /\s*[İIi]şte\s+(?:detaylar|ayrıntılar)[^.]*$|\s*(?:detaylar|ayrıntılar)\s+haber(?:imiz|in)?(?:de|in devamında)[^.]*$|\s*(?:haberin\s+)?devamı(?:\s+için)?[^.]*(?:tıklayın|haberimizde)[^.]*$|\s*ayrıntılar\s+için[^.]*$/i;
// Not news text: a stock's quote page blurb, or a page whose "description" is a
// run of other headlines (several "!" or title-cased fragments).
function notNews(t) {
  if (/sayfasında .{0,60}(grafiğini|güncel fiyatını)|fiyatını .{0,40} sayfasında bulabilirsiniz/i.test(t)) return true;
  if ((t.match(/!/g) || []).length >= 2) return true;
  return false;
}
// A dateline glued to the first paragraph ("03 Eki Cumartesi 2026 19:00 …") and
// call-to-action sentences ("… aşağıdaki linkten takip edebilirsiniz.").
const DATELINE = /^\d{1,2}\s+\S+\s+(?:\S+\s+)?\d{4}\s+\d{1,2}[:.]\d{2}\s+/;
const CTA = /[^.!?]*(?:aşağıdaki (?:link|bağlantı)|takip edebilirsiniz|tıklayın|abone olun|bizi takip edin)[^.!?]*[.!?]?/gi;
function cleanText(t) {
  return String(t || "").replace(/\s+/g, " ").trim().replace(DATELINE, "").replace(CTA, " ")
    .replace(TEASER, "").replace(/[;:,\s]+$/, "").replace(/\s+/g, " ").trim();
}
// Near-duplicate check: the meta description is often the first paragraph again.
const sameStart = (a, b) => normText(a).slice(0, 60) === normText(b).slice(0, 60);

// The article's opening: the outlet's own description, then its first relevant
// paragraphs, up to SUMMARY_MAX_CHARS, cut at a sentence end.
function articleLede(html, title) {
  const parts = [];
  const meta = cleanText(metaDescription(html).replace(/…$/, ""));
  if (meta && meta.length >= 60 && sharesTopic(meta, title) && !isEchoSummary(meta, title, "") && !notNews(meta)) parts.push(meta);
  for (const p0 of extractParagraphs(html)) {
    if (p0.startsWith("• ")) { if (parts.length) parts.push(p0); continue; } // list/table lines follow the text they belong to
    const p = cleanText(p0);
    if (p.length < 60 || notNews(p) || !sharesTopic(p, title) && !parts.length) continue;
    if (parts.some((q) => sameStart(q, p) || normText(q).includes(normText(p).slice(0, 80)))) continue;
    parts.push(p);
    if (parts.join("\n\n").length >= SUMMARY_MAX_CHARS) break;
  }
  if (!parts.length) return null;
  const out = summariseParagraphs(parts);
  return out && out.length >= 80 ? out : null;
}

// → { summary, pub } — either may be null. `pub` is the publisher's own URL.
async function fetchArticleSummary(url, title, knownPub = null) {
  let pub = knownPub;
  try {
    const host = new URL(url).hostname;
    let target = pub || url;
    if (!pub && /(^|\.)google\.com$/.test(host)) {
      pub = await resolveGoogleNewsUrl(url);
      if (!pub) return { summary: null, pub: null };
      target = pub;
    }
    const signal = AbortSignal.timeout ? AbortSignal.timeout(SUMMARY_TIMEOUT_MS) : undefined;
    const r = await fetch(target, {
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "tr,en;q=0.8" },
      signal,
    });
    if (!r.ok) return { summary: null, pub };
    const ct = r.headers.get("content-type") || "";
    if (!/text\/html/i.test(ct)) return { summary: null, pub };
    const html = await r.text();
    return { summary: articleLede(html, title), pub };
  } catch {
    return { summary: null, pub };
  }
}

// Enrich a {sym: items[]} map in place: fill missing summaries, newest first,
// capped per run. A real summary is kept (cache); a "headline + source" echo
// from the feed counts as missing. `st` counts failed tries.
// `press`: only press items get the echo check — a KAP item's summary is its
// subject line, which legitimately repeats part of the title.
async function enrichSummaries(itemsBySym, { press = false, cap = SUMMARY_MAX_PER_RUN } = {}) {
  const pending = [];
  for (const sym of Object.keys(itemsBySym || {})) {
    for (const it of itemsBySym[sym] || []) {
      if (!it || !it.url) continue;
      if (press && it.summary && isEchoSummary(it.summary, it.title, it.source)) it.summary = null;
      // Summaries from older rules are redone once (they have the publisher URL already).
      const stale = press && it.summary && it.sv !== SUMMARY_VERSION;
      if ((!it.summary || stale) && (it.st || 0) < SUMMARY_MAX_TRIES) pending.push(it);
    }
  }
  pending.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const batch = pending.slice(0, cap);
  if (!batch.length) return 0;
  let filled = 0;
  await mapLimit(batch, SUMMARY_CONCURRENCY, async (it) => {
    const blockedBefore = googleBlocked;
    const { summary, pub } = await fetchArticleSummary(it.url, it.title || "", it.pub || null);
    if (pub) it.pub = pub;
    if (summary) { it.summary = summary; if (press) it.sv = SUMMARY_VERSION; delete it.st; filled++; }
    else if (press && it.summary && it.sv !== SUMMARY_VERSION) {
      // Re-read failed: keep the old text only if it passes today's rules.
      const old = cleanText(it.summary);
      it.summary = old.length >= 60 && !notNews(old) ? old : null;
      it.sv = SUMMARY_VERSION;
    } else {
      if (it.summary === undefined) it.summary = null;
      // A Google rate limit is not the article's fault — don't burn a try on it.
      if (!googleBlocked && !blockedBefore) it.st = (it.st || 0) + 1;
    }
  });
  if (googleBlocked) console.log("  (Google yönlendirme çözümü sınırlandı — kalan özetler sonraki koşuya)");
  return filled;
}

// ---- KAP disclosure text ------------------------------------------------------
// The KAP feed gives only a subject line. The disclosure page (Next.js) streams
// its content as self.__next_f.push([1,"…"]) chunks; inside is the filing as
// HTML: the company's own explanation (Turkish + English) and form fields
// (label → value rows, or header-row tables). Official public statements — shown
// in full in the app, attributed to KAP. Stored in kapText.json keyed by the
// disclosure number, loaded by the app only when a KAP item is opened.
const KAP_TEXT_DAYS = 14;      // fetch text for disclosures this recent
const KAP_TEXT_KEEP_DAYS = 45; // drop older entries from the file
const KAP_TEXT_MAX = 1500;
// KAP answers 429 to bursts (measured 2026-10-04): one page at a time, a pause
// between, stop for the run at the first 429. The newest filings go first.
const KAP_TEXT_PER_RUN = Number(process.env.KAP_TEXT_CAP) || 60;
const KAP_TEXT_GAP_MS = 700;
const KAP_TEXT_VERSION = 2; // 2: list items kept — older entries are fetched again (after new ones)
const EN_WORDS = /\b(the|of|and|our|has|been|with|that|which|is|are|to|regarding|company)\b/gi;
const isEnglish = (t) => (t.match(EN_WORDS) || []).length >= 3 && !/[çğışöüÇĞİŞÖÜ]/.test(t);
const strip = (h) => decodeEntities(decodeEntities(String(h).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))).replace(/\s+/g, " ").trim();

function kapTextFromHtml(html) {
  let payload = "";
  for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { payload += JSON.parse(m[1]); } catch { /* skip chunk */ }
  }
  if (!payload) return null;
  const fields = [];
  const seenLabel = new Set();
  const push = (l, v) => {
    l = strip(l); v = strip(v);
    // "Müşteri (Customer)", "Hayır (No)": drop the English twin in parentheses.
    const twin = /^(.+?)\s*\(([A-Za-z][A-Za-z ]*)\)$/.exec(v);
    if (twin && /[^\x00-\x7F]/.test(twin[1])) v = twin[1];
    if (!l || !v || l === v || l.length > 120 || v.length > 300 || /^oda_|^-$/.test(v) || isEnglish(l) || seenLabel.has(l)) return;
    if (/^(evet|hayır)$/i.test(v) && /ertelenmiş|ertelenen/i.test(l)) return; // boilerplate yes/no
    // KAP's form scaffolding: template placeholders, empty lists, the bilingual
    // header row ("Türkçe Turkish / İngilizce English"), update/correction flags.
    if (/[\[\]]/.test(l + v) || /\?$/.test(v)) return;
    if (/^(ilgili (şirketler|fonlar)|türkçe|yapılan açıklama (güncelleme|düzeltme)|update notification|correction notification|bildirim içeriği|announcement content)/i.test(l)) return;
    // English labels of the bilingual form (no Turkish letters + a common English word).
    if (!/[çğışöüÇĞİŞÖÜ]/.test(l) && /\b(of|the|if|date|business|contract|content|explanations?|expected|nature|name|amount|share|capital|company|board|decision|announcement)\b/i.test(l)) return;
    if (/\b(Related|Notification|Flag|Turkish|English|Companies|Funds)\b/.test(l + " " + v)) return;
    seenLabel.add(l); fields.push([l, v]);
  };
  // Innermost rows only (no nested <tr>).
  const rows = [...payload.matchAll(/<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 2) push(r[0], r[1]);
    else if (r.length > 2 && rows[i + 1] && rows[i + 1].length === r.length) {
      // A header row + its value row. If the "values" hold no digit at all they are
      // more headers (KAP nests label tables) — pairing them would read label = label.
      if (rows[i + 1].some((c) => /\d/.test(strip(c)))) r.forEach((h, k) => push(h, rows[i + 1][k]));
      i++;
    }
  }
  // Taxonomy forms (e.g. "Yeni İş İlişkisi"): the Turkish label sits in a nested
  // table (gwt-Label … content-tr), its value in the next
  // <td class="taxonomy-context-value … content-tr">. Pair each value with the
  // closest label before it.
  const labels = [...payload.matchAll(/class="gwt-Label multi-language-content content-tr"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => ({ at: m.index, text: m[1] }));
  for (const m of payload.matchAll(/class="taxonomy-context-value[^"]*content-tr[^"]*"[^>]*>([\s\S]*?)<\/td>/g)) {
    let lab = null;
    for (const l of labels) { if (l.at < m.index) lab = l; else break; }
    if (lab) push(lab.text, m[1]);
  }
  // Paragraphs AND list items, in document order — explanations often say
  // "… kararı ile;" and continue in a numbered list.
  const prose = [];
  for (const m of payload.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = strip(m[2]);
    const min = m[1].toLowerCase() === "li" ? 8 : 40;
    if (t.length >= min && !isEnglish(t) && !/^oda_/.test(t) && !prose.includes(t)) prose.push(m[1].toLowerCase() === "li" ? "• " + t : t);
  }
  let text = "";
  for (const p of prose) {
    if (text && text.length + p.length + 2 > KAP_TEXT_MAX) break;
    text = text ? text + "\n\n" + p : p;
  }
  if (text.length > KAP_TEXT_MAX) text = text.slice(0, KAP_TEXT_MAX - 1).replace(/\s+\S*$/, "") + "…";
  const f = fields.filter(([l]) => !prose.some((p) => p.includes(l))).slice(0, 12);
  return text || f.length ? { t: text || null, f } : null;
}

async function enrichKapText(news, prev) {
  const out = {};
  const keepAfter = Date.now() - KAP_TEXT_KEEP_DAYS * 864e5;
  for (const [id, v] of Object.entries(prev || {})) if (v && Date.parse(v.d) >= keepAfter) out[id] = v;
  const fetchAfter = Date.now() - KAP_TEXT_DAYS * 864e5;
  const pending = [];
  const seenId = new Set();
  for (const items of Object.values(news || {})) {
    for (const it of items || []) {
      const id = /\/Bildirim\/(\d+)/.exec(it.url || "")?.[1];
      if (!id || seenId.has(id) || (out[id] && out[id].v === KAP_TEXT_VERSION) || !(Date.parse(it.date) >= fetchAfter)) continue;
      // Routine debt-instrument filings carry no reader text worth fetching.
      if (/finansman bonosu|borçlanma aracı|kira sertifikası|varant|pay dışında sermaye piyasası aracı/i.test(it.title || "")) continue;
      seenId.add(id); pending.push({ id, date: it.date });
    }
  }
  // Missing first (newest first), then entries made by older extraction rules.
  pending.sort((a, b) => (out[a.id] ? 1 : 0) - (out[b.id] ? 1 : 0) || String(b.date).localeCompare(String(a.date)));
  let filled = 0, limited = false;
  for (const { id, date } of pending.slice(0, KAP_TEXT_PER_RUN)) {
    try {
      const r = await fetch("https://www.kap.org.tr/tr/Bildirim/" + id, {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "tr" },
        signal: AbortSignal.timeout ? AbortSignal.timeout(SUMMARY_TIMEOUT_MS) : undefined,
      });
      if (r.status === 429) { limited = true; break; }
      if (r.ok) {
        const x = kapTextFromHtml(await r.text());
        if (x) { out[id] = { d: String(date).slice(0, 10), v: KAP_TEXT_VERSION, ...x }; filled++; }
      }
    } catch { /* next run */ }
    await new Promise((res) => setTimeout(res, KAP_TEXT_GAP_MS));
  }
  console.log("  KAP bildirim metni: " + filled + " eklendi · toplam " + Object.keys(out).length +
    " · bekleyen " + Math.max(0, pending.length - filled) + (limited ? " (KAP sınırı — sonraki koşuda devam)" : ""));
  return out;
}

// ---- commodity news (Google News RSS, per metal) -------------------------
// The metals section deserves the same "what's moving it" feed the stocks have.
// One precise Turkish query per commodity; deduped, most-recent first. Runs on
// the same hourly gate as market news to keep Google requests modest.
const COMMODITY_NEWS_Q = {
  "gram-altin":    '("gram altın" OR "altın fiyat" OR "ons altın") (TL OR dolar OR fiyat)',
  "gram-gumus":    '("gümüş fiyat" OR "gram gümüş" OR "ons gümüş")',
  "gram-platin":   '("platin fiyat" OR platinyum) (metal OR ons OR fiyat)',
  "gram-paladyum": '("paladyum fiyat" OR palladium) (metal OR ons OR fiyat)',
  "kg-bakir":      '("bakır fiyat" OR "bakır ton" OR "London Metal Exchange bakır" OR "copper price")',
};
async function fetchCommodityNews(prev) {
  const force = process.env.FORCE_NEWS === "1";
  if (!force && new Date().getUTCMinutes() >= 15) {
    return { updatedAt: (prev && prev.updatedAt) || null, items: (prev && prev.items) || {}, skipped: true };
  }
  const out = {};
  for (const [sym, q] of Object.entries(COMMODITY_NEWS_Q)) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:14d") + "&hl=tr&gl=TR&ceid=TR:tr";
    try {
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl });
      if (!r.ok) { out[sym] = (prev && prev.items && prev.items[sym]) || []; continue; }
      const items = parseRssItems(await r.text());
      const seen = new Set();
      const list = [];
      for (const it of items) {
        const k = (it.title || "").toLowerCase();
        if (!k || seen.has(k) || !isTrustedItem(it)) continue; // reliable outlets only
        seen.add(k);
        list.push(it);
      }
      list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      out[sym] = list.slice(0, 15);
    } catch {
      out[sym] = (prev && prev.items && prev.items[sym]) || [];
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  return { updatedAt: new Date().toISOString(), items: out };
}

// Quarterly + yearly revenue / net income / margins — the numbers a real
// financial page leads with. Yahoo's earnings.financialsChart is the reliable
// source (the raw incomeStatement submodules went empty in 2024).
function financials(qs, fd) {
  const fc = qs && qs.earnings && qs.earnings.financialsChart;
  if (!fc) return {};
  const map = (arr) =>
    (arr || [])
      .filter((r) => r && (r.revenue != null || r.earnings != null))
      .map((r) => ({
        p: String(r.date),
        rev: r.revenue != null ? Math.round(r.revenue) : null,
        ni: r.earnings != null ? Math.round(r.earnings) : null,
        m: r.profitMargin != null ? round(r.profitMargin, 4) : null,
      }));
  const q = map(fc.quarterly), y = map(fc.yearly);
  if (!q.length && !y.length) return {};
  return {
    fin: {
      q, y,
      grossM: round(fd.grossMargins, 4),
      opM: round(fd.operatingMargins, 4),
      netM: round(fd.profitMargins, 4),
      revG: round(fd.revenueGrowth, 4),
      epsG: round(fd.earningsGrowth, 4),
    },
  };
}

// Analyst recommendation distribution (latest month). Reported as raw counts —
// the panel never distils these into its own AL/SAT verdict; it shows what the
// covering brokerages collectively think, attributed.
function recTrend(qs) {
  const t = qs && qs.recommendationTrend && qs.recommendationTrend.trend && qs.recommendationTrend.trend[0];
  if (!t) return {};
  const buy = (t.strongBuy || 0) + (t.buy || 0);
  const hold = t.hold || 0;
  const sell = (t.sell || 0) + (t.strongSell || 0);
  if (buy + hold + sell === 0) return {};
  return { recBuy: buy, recHold: hold, recSell: sell };
}

// ---- index history -------------------------------------------------------
// The OFFICIAL Borsa İstanbul indices (free-float market-cap weighted) — a
// different, more authoritative series than the app's own equal-weight average.
// BIST 50 (XU050) is intentionally omitted: Yahoo still has only one day of
// history for it, and a chart from a single point would be a lie. Banka (XBANK)
// and Sanayi (XUSIN) do have full history, so they're included.
async function fetchIndexHistory(startDate) {
  const defs = [
    { code: "XU100", yh: "XU100.IS", label: "BIST 100" },
    { code: "XU030", yh: "XU030.IS", label: "BIST 30" },
    { code: "XBANK", yh: "XBANK.IS", label: "BIST Banka" },
    { code: "XUSIN", yh: "XUSIN.IS", label: "BIST Sanayi" },
  ];
  const out = {};
  for (const d of defs) {
    try {
      const [ch, q] = await Promise.all([
        yf.chart(d.yh, { period1: startDate, interval: "1d" }),
        yf.quote(d.yh).catch(() => null),
      ]);
      const rows = (ch.quotes || []).filter((r) => r.close != null);
      if (rows.length < 100) continue;
      const ds = rows.map((r) => r.date.toISOString().slice(0, 10));
      out[d.code] = {
        code: d.code, label: d.label,
        value: q ? round(q.regularMarketPrice, 2) : round(rows[rows.length - 1].close, 2),
        change: q ? round(q.regularMarketChangePercent, 2) : null,
        d: ds,
        o: rows.map((r) => round(r.open, 2)),
        h: rows.map((r) => round(r.high, 2)),
        l: rows.map((r) => round(r.low, 2)),
        c: rows.map((r) => round(r.close, 2)),
      };
    } catch (e) {
      console.log("  " + d.code + " geçmişi alınamadı: " + e.message);
    }
  }
  return out;
}

// ---- commodities (precious + industrial metals) --------------------------
// Each metal's price in TRY per its natural retail unit. Precious metals trade
// per troy ounce (31.1035 g) and are bought as GRAMS in Turkey; copper trades
// per pound (453.592 g) and is quoted per KG. Stored value = USD price × USDTRY
// / grams-per-unit × scale, so gram gold is ₺/gr and copper is ₺/kg.
const COMMODITIES = [
  { symbol: "gram-altin",    key: "XAU", label: "Gram Altın",    yh: "GC=F", grams: 31.1034768, scale: 1,    dec: 2 },
  { symbol: "gram-gumus",    key: "XAG", label: "Gram Gümüş",    yh: "SI=F", grams: 31.1034768, scale: 1,    dec: 2 },
  { symbol: "gram-platin",   key: "XPT", label: "Gram Platin",   yh: "PL=F", grams: 31.1034768, scale: 1,    dec: 2 },
  { symbol: "gram-paladyum", key: "XPD", label: "Gram Paladyum", yh: "PA=F", grams: 31.1034768, scale: 1,    dec: 2 },
  { symbol: "kg-bakir",      key: "XCU", label: "Kg Bakır",      yh: "HG=F", grams: 453.59237,  scale: 1000, dec: 2 },
];

// ---- FX history ----------------------------------------------------------
// Daily closes for the currencies a BIST investor actually measures against.
// Needed because "what did this stock do in dollars" cannot be answered with
// today's rate alone — every past price has to be divided by the rate on ITS
// day. With TRY inflation running as it does, the TRY chart and the USD chart
// of the same stock can tell opposite stories, so this is not a garnish.
async function fetchFxHistory(startDate) {
  const out = {};
  const series = async (yhSymbol) => {
    const ch = await yf.chart(yhSymbol, { period1: startDate, interval: "1d" });
    const rows = (ch.quotes || []).filter((r) => r.close != null);
    return {
      d: rows.map((r) => r.date.toISOString().slice(0, 10)),
      c: rows.map((r) => r.close),
    };
  };
  try {
    const [usd, eur, gbp] = await Promise.all([
      series("USDTRY=X"),
      series("EURTRY=X").catch(() => null),
      series("GBPTRY=X").catch(() => null),
    ]);
    out.USD = { d: usd.d, c: usd.c.map((v) => round(v, 4)) };
    if (eur) out.EUR = { d: eur.d, c: eur.c.map((v) => round(v, 4)) };
    if (gbp) out.GBP = { d: gbp.d, c: gbp.c.map((v) => round(v, 4)) };

    // Commodity metals in TRY per retail unit. Each day divided by ITS OWN USD
    // rate (no look-ahead), skipping days with no FX print rather than guessing.
    const usdBy = new Map(usd.d.map((d, i) => [d, usd.c[i]]));
    for (const m of COMMODITIES) {
      try {
        const s = await series(m.yh);
        const d = [], c = [];
        for (let i = 0; i < s.d.length; i++) {
          const rate = usdBy.get(s.d[i]);
          if (rate == null) continue;
          d.push(s.d[i]);
          c.push(round((s.c[i] * rate * m.scale) / m.grams, m.dec));
        }
        if (d.length > 30) out[m.key] = { d, c };
      } catch { /* this metal's history optional */ }
    }
  } catch (e) {
    console.log("  FX geçmişi alınamadı: " + e.message);
    return null;
  }
  return out;
}

// ---- markets (FX + gold) -------------------------------------------------
async function fetchMarkets(prevMarkets) {
  const fx = [];
  const map = [["USDTRY=X", "USD", "Dolar"], ["EURTRY=X", "EUR", "Euro"], ["GBPTRY=X", "GBP", "Sterlin"]];
  let usdtry = null;
  for (const [yh, sym, label] of map) {
    try {
      const q = await yf.quote(yh);
      const v = q.regularMarketPrice;
      if (sym === "USD") usdtry = v;
      fx.push({ symbol: sym, label, value: round(v, 2), change: round(q.regularMarketChangePercent, 2) });
    } catch {
      fx.push({ symbol: sym, label, value: null, change: null });
    }
  }
  // Commodity metals: current TRY per retail unit (see COMMODITIES).
  for (const m of COMMODITIES) {
    try {
      const g = await yf.quote(m.yh);
      if (g.regularMarketPrice && usdtry) {
        fx.push({
          symbol: m.symbol, label: m.label,
          value: round((g.regularMarketPrice * usdtry * m.scale) / m.grams, m.dec),
          change: round(g.regularMarketChangePercent, 2),
        });
      }
    } catch { /* skip this metal */ }
  }
  // inflation: preserve previous (Yahoo doesn't provide TR CPI)
  const inflation = (prevMarkets && prevMarkets.inflation) || null;
  return { fx, inflation };
}

// ---- universe (all BIST, light: price + change) --------------------------
// One batched Yahoo quote per ~50 symbols. No history/indicators (that stays
// core-100 only) — just enough so non-100 stocks show price/change on search.
async function fetchUniverse(coreStocks) {
  const seed = await readJson("universe-seed.json", []); // [{symbol,name}]
  if (!seed.length) return null;
  const coreMap = {};
  for (const s of coreStocks) coreMap[s.symbol] = s;
  const out = [];
  const CH = 50;
  for (let i = 0; i < seed.length; i += CH) {
    const part = seed.slice(i, i + CH);
    process.stdout.write("\rUniverse " + Math.min(i + CH, seed.length) + "/" + seed.length + "   ");
    try {
      const arr = await yf.quote(part.map((s) => s.symbol + ".IS"));
      const bym = {};
      for (const q of Array.isArray(arr) ? arr : [arr]) bym[(q.symbol || "").replace(".IS", "")] = q;
      for (const s of part) {
        const core = coreMap[s.symbol], q = bym[s.symbol];
        out.push({
          symbol: s.symbol, name: s.name,
          close: core ? core.close : (q ? round(q.regularMarketPrice, 2) : null),
          change: core ? core.change : (q ? round(q.regularMarketChangePercent, 2) : null),
        });
      }
    } catch {
      for (const s of part) out.push({ symbol: s.symbol, name: s.name, close: null, change: null });
    }
  }
  process.stdout.write("\n");
  return out;
}


// ---- extended tier (every BIST symbol outside the core 100) ---------------
// The core 100 gets full daily OHLC since 2021 on every run. Doing that for all
// ~770 symbols on a 10-minute cron is not viable (thousands of requests, a
// >10MB history.json every client would download), so the rest of the market
// gets a lighter, once-a-day tier written to separate *Ext.json files that the
// app fetches lazily — only when someone opens a non-100 stock.
//
// Enabled with FULL=1 (or --full). Close-only 1y history keeps the file small;
// the chart falls back to line mode when OHLC is absent.
const EXT_CONCURRENCY = 5;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function buildExtended(coreSymbols) {
  const seed = await readJson("universe-seed.json", []);
  if (!seed.length) return null;
  const core = new Set(coreSymbols);
  const targets = seed.map((s) => s.symbol).filter((s) => !core.has(s));
  if (!targets.length) return null;

  const oneYearAgo = new Date(Date.now() - 370 * 864e5).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  const technicals = {}, pivotsOut = {}, history = {}, fundamentals = {}, details = {};
  const nameOf = {};
  for (const row of seed) nameOf[row.symbol] = row.name;
  let done = 0, ok = 0;

  await mapLimit(targets, EXT_CONCURRENCY, async (sym) => {
    done++;
    if (done % 25 === 0) process.stdout.write("\rExtended " + done + "/" + targets.length + "   ");
    try {
      const [ch, qs] = await Promise.all([
        yf.chart(sym + ".IS", { period1: oneYearAgo, interval: "1d" }),
        yf.quoteSummary(sym + ".IS", {
          modules: ["summaryDetail", "defaultKeyStatistics", "financialData", "assetProfile", "calendarEvents", "recommendationTrend", "earnings"],
        }).catch(() => null),
      ]);
      const rows = (ch.quotes || []).filter((r) => r.close != null);
      if (rows.length < 30) return null; // too thin to compute anything honest
      const closes = rows.map((r) => r.close);
      const price = closes[closes.length - 1];

      const e20 = ema(closes, 20), e50 = ema(closes, 50);
      const sma20v = sma(closes, 20), sd20 = stdev(closes, 20);
      const mac = macd(closes);
      technicals[sym] = {
        price: round(price, 2), sma20: round(sma20v, 2), ema20: round(e20, 2), ema50: round(e50, 2),
        sma50: round(sma(closes, 50), 2), sma200: round(sma(closes, 200), 2),
        bbUpper: sma20v != null && sd20 != null ? round(sma20v + 2 * sd20, 2) : null,
        bbLower: sma20v != null && sd20 != null ? round(sma20v - 2 * sd20, 2) : null,
        cross: detectCross(closes),
        rsi: round(rsiWilder(closes), 1),
        macd: mac ? round(mac.macd, 3) : null,
        macdSignal: mac ? round(mac.signal, 3) : null,
        macdHist: mac ? round(mac.hist, 3) : null,
        trend: trendFrom(price, e20, e50),
      };

      const prevRows = rows.filter((r) => r.date.toISOString().slice(0, 10) < todayStr);
      const base = prevRows[prevRows.length - 1] || rows[rows.length - 1];
      if (base && base.high != null && base.low != null && base.close != null) {
        const p = pivots(base.high, base.low, base.close);
        pivotsOut[sym] = {
          pp: round(p.pp, 2), s1: round(p.s1, 2), s2: round(p.s2, 2), s3: round(p.s3, 2),
          r1: round(p.r1, 2), r2: round(p.r2, 2), r3: round(p.r3, 2),
        };
      }

      const dts = rows.map((r) => r.date.toISOString().slice(0, 10));
      history[sym] = {
        s: dts[0], e: dts[dts.length - 1], d: dts, c: closes.map((c) => round(c, 2)),
        v: rows.map((r) => (r.volume != null ? Math.round(r.volume) : null)),
      };

      if (qs) {
        const sd = qs.summaryDetail || {}, ks = qs.defaultKeyStatistics || {};
        const fd = qs.financialData || {}, ap = qs.assetProfile || {};
        fundamentals[sym] = {
          sector: mapSector(ap.sector, sym),
          marketCap: sd.marketCap != null ? Math.round(sd.marketCap) : null,
          pe: round(sd.trailingPE, 2),
          pb: round(ks.priceToBook, 2),
          roe: round(fd.returnOnEquity, 4),
          w52low: round(sd.fiftyTwoWeekLow, 2),
          w52high: round(sd.fiftyTwoWeekHigh, 2),
          divYield: round(sd.dividendYield, 4),
          // Third-party 12-month price targets. Reported, never generated here:
          // the panel's own guardrail forbids IT from naming a price, but what
          // brokerages publish is a fact about the market and belongs on the page.
          tgtLow: round(fd.targetLowPrice, 2),
          tgtMean: round(fd.targetMeanPrice, 2),
          tgtHigh: round(fd.targetHighPrice, 2),
          analysts: fd.numberOfAnalystOpinions != null ? Math.round(fd.numberOfAnalystOpinions) : null,
          ...recTrend(qs),
          ...financials(qs, fd),
        };
        { const _dq = checkFundamentals(fundamentals[sym]); if (_dq) fundamentals[sym].dq = _dq; }

        // Dividend / earnings for the modal's stat tiles + timeline. The core
        // 100 gets a richer, Borsa_MCP-seeded timeline; here we can only build
        // it from what Yahoo returns, so it holds the two facts we actually
        // know rather than pretending to a full history.
        const ce = qs.calendarEvents || {};
        const today = new Date().toISOString().slice(0, 10);
        const earnDates = (ce.earnings && ce.earnings.earningsDate) || [];
        const nextEarn = (Array.isArray(earnDates) ? earnDates : [earnDates])
          .map(isoDate).filter((d) => d && d >= today).sort()[0] || null;
        const lastDivDate = isoDate(ks.lastDividendDate);
        const lastDivVal = ks.lastDividendValue != null ? round(ks.lastDividendValue, 4) : null;
        const lastDividend = lastDivDate && lastDivVal != null ? { date: lastDivDate, amount: lastDivVal } : null;

        const timeline = [];
        if (nextEarn) {
          timeline.push({
            date: nextEarn, type: "earnings", future: true,
            label: "Bilanço açıklaması (beklenen)",
            detail: "Yahoo Finance takviminden alınan beklenen tarih; şirket teyit etmemiş olabilir.",
          });
        }
        if (lastDividend) {
          timeline.push({
            date: lastDividend.date, type: "dividend", future: false,
            label: "Son ödenen temettü",
            detail: "Hisse başına " + String(lastDividend.amount).replace(".", ",") + " TL.",
          });
        }
        timeline.sort((a, b) => b.date.localeCompare(a.date));

        details[sym] = {
          symbol: sym,
          name: nameOf[sym] || sym,
          annualDividend: sd.dividendRate != null ? round(sd.dividendRate, 4) : null,
          nextDividend: null,
          lastDividend,
          nextEarningsDate: nextEarn,
          epsTtm: ks.trailingEps != null ? round(ks.trailingEps, 4) : null,
          timeline,
        };
      }
      ok++;
    } catch {
      /* a delisted or illiquid ticker simply stays out of the extended tier */
    }
    return null;
  });

  process.stdout.write("\n");
  console.log("  extended: " + ok + "/" + targets.length + " sembol hesaplandı");
  return { technicals, pivots: pivotsOut, history, fundamentals, details };
}

// ---- main ----------------------------------------------------------------
// ---- fast intraday snapshot ---------------------------------------------
// One batched Yahoo quote for all core symbols → data/intraday.json.
// The app merges this over stocks.json for ~1-2 min fresh prices, and each
// quote carries a `quality` flag (ok | stale | missing) so the UI can be honest.
async function refreshIntraday(symbols) {
  const yhSymbols = symbols.map((s) => s + ".IS");
  const quotes = {};
  // Batch in chunks to stay under Yahoo's per-request limits.
  for (let i = 0; i < yhSymbols.length; i += 200) {
    const part = yhSymbols.slice(i, i + 200);
    try {
      const arr = await yf.quote(part);
      for (const q of Array.isArray(arr) ? arr : [arr]) {
        quotes[(q.symbol || "").replace(".IS", "")] = q;
      }
    } catch (e) {
      console.log("  intraday batch failed (" + e.message + ")");
    }
  }

  // Stale = this quote lags the FRESHEST quote of the batch by >6 min (the stock
  // stopped trading: halt / illiquid). It used to be judged against the wall
  // clock, but Yahoo's BIST feed is ~15 min delayed by itself, so every quote
  // was "stale" all session long and the flag carried no information.
  const STALE_MS = 6 * 60_000;
  let freshestMs = 0;
  for (const sym of symbols) {
    const rt = quotes[sym]?.regularMarketTime;
    const ms = rt instanceof Date ? rt.getTime() : (typeof rt === "number" ? rt * 1000 : NaN);
    if (isFinite(ms) && ms > freshestMs) freshestMs = ms;
  }
  const out = {};
  let ok = 0, stale = 0, missing = 0;
  for (const sym of symbols) {
    const q = quotes[sym];
    const last = q?.regularMarketPrice;
    if (q == null || last == null || !isFinite(last)) { missing++; continue; }
    const tSec = q.regularMarketTime instanceof Date
      ? q.regularMarketTime.getTime() / 1000
      : (typeof q.regularMarketTime === "number" ? q.regularMarketTime : null);
    const tISO = tSec ? new Date(tSec * 1000).toISOString() : null;
    const quality = (tSec && freshestMs && freshestMs - tSec * 1000 > STALE_MS) ? "stale" : "ok";
    quality === "stale" ? stale++ : ok++;
    out[sym] = {
      last: round(last, 2),
      chg: round(q.regularMarketChangePercent, 2),
      vol: q.regularMarketVolume ?? null,
      t: tISO,
      quality,
    };
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "yahoo-quote",
    counts: { ok, stale, missing, total: symbols.length },
    quotes: out,
  };
  await fs.writeFile(path.join(DATA_DIR, "intraday.json"), JSON.stringify(payload));
  console.log(`intraday.json yazıldı — ok:${ok} stale:${stale} missing:${missing}`);
}

// ---- news-only refresh (weekends included) -------------------------------
// Writes news.json / marketNews.json / commodityNews.json only. Leaves every
// price/technical/fundamental file untouched so a weekend run never regresses
// stale market data over the last weekday close.
async function refreshNewsOnly(prevStocks) {
  const stocks = prevStocks.stocks || [];
  const symbols = stocks.map((s) => s.symbol);

  const prevNews = await readJson("news.json", {});
  const uniSeedForNews = await readJson("universe-seed.json", []);
  const newsSymbols = [...new Set([...symbols, ...uniSeedForNews.map((s) => s.symbol)])];
  const news = await fetchNews(newsSymbols, prevNews);

  const prevMarketNews = await readJson("marketNews.json", { updatedAt: null, items: {} });
  const marketNews = await fetchMarketNews(stocks, prevMarketNews);

  if (news && news !== prevNews) {
    process.stdout.write("KAP özetleri çekiliyor… ");
    console.log((await enrichSummaries(news, { cap: 30 })) + " eklendi");
  }
  if (!marketNews.skipped) {
    process.stdout.write("Haber özetleri çekiliyor… ");
    console.log((await enrichSummaries(marketNews.items, { press: true })) + " eklendi");
  }

  const prevCommodityNews = await readJson("commodityNews.json", { updatedAt: null, items: {} });
  const commodityNews = await fetchCommodityNews(prevCommodityNews);

  {
    const kapText = await enrichKapText(news, await readJson("kapText.json", {}));
    await fs.writeFile(path.join(DATA_DIR, "kapText.json"), JSON.stringify(kapText));
  }
  if (news !== prevNews) await fs.writeFile(path.join(DATA_DIR, "news.json"), JSON.stringify(news));
  await fs.writeFile(path.join(DATA_DIR, "marketNews.json"), JSON.stringify({ updatedAt: marketNews.updatedAt, items: marketNews.items || {} }));
  await fs.writeFile(path.join(DATA_DIR, "commodityNews.json"), JSON.stringify({ updatedAt: commodityNews.updatedAt, items: commodityNews.items || {} }));

  const mn = Object.values(marketNews.items || {}).filter((a) => a && a.length).length;
  console.log(`news-only yazıldı — KAP:${Object.keys(news).length} · piyasa:${mn}${marketNews.skipped ? " (piyasa/emtia saat kapısında atlandı)" : ""}`);
}

// ---- macro-only refresh (EVDS) -------------------------------------------
const TR_MONTHS = ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
function trMonthLabel(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  return TR_MONTHS[Number(m[2]) - 1] + " " + m[1];
}
const pctStr = (v) => (v == null ? null : "%" + v.toFixed(2).replace(".", ","));

async function refreshMacroOnly(prevStocks) {
  const key = process.env.EVDS_KEY || "";
  if (!key) { console.log("EVDS_KEY yok — makro güncelleme atlandı."); return; }

  // 1) CPI monthly index since 2021 → cpiHistory.json (the durable artifact).
  const cpi = await evdsSeries(key, EVDS_CODES.cpi, "01-01-2021");
  if (cpi.length) {
    const d = cpi.map((x) => x.date), c = cpi.map((x) => round(x.value, 2));
    await fs.writeFile(path.join(DATA_DIR, "cpiHistory.json"), JSON.stringify({ code: EVDS_CODES.cpi, source: "EVDS", updatedAt: new Date().toISOString(), d, c }));
    console.log(`cpiHistory.json yazıldı — ${cpi.length} ay (son: ${d[d.length - 1]})`);
  } else {
    console.log("EVDS CPI boş — cpiHistory yazılmadı.");
  }

  // 2) Patch the CPI rows in stocks.json.macro from the same series.
  const macro = Array.isArray(prevStocks.macro) ? prevStocks.macro.slice() : [];
  if (cpi.length >= 13) {
    const last = cpi[cpi.length - 1], prev = cpi[cpi.length - 2];
    const monthly = prev.value > 0 ? (last.value / prev.value - 1) * 100 : null;
    const yearly = yoyPct(cpi);
    const label = trMonthLabel(last.date);
    for (const row of macro) {
      if (/Enflasyon Oranı \(Aylık\)/i.test(row.event) && monthly != null) {
        row.previous = row.actual ?? row.previous;
        row.actual = pctStr(monthly); row.status = "released"; if (label) row.date = label;
      }
      if (/Enflasyon Oranı \(Yıllık\)/i.test(row.event) && yearly != null) {
        row.previous = row.actual ?? row.previous;
        row.actual = pctStr(yearly); row.status = "released"; if (label) row.date = label;
      }
    }
    console.log(`macro güncellendi — TÜFE aylık ${pctStr(monthly)} · yıllık ${pctStr(yearly)}`);
  }

  // 3) Candidate macro series (policy rate / unemployment / current account).
  // Fetch latest, log, and accept ONLY when the value is in a sane range. A wrong
  // code (empty) or a mislabelled-but-valid code (insane value) is rejected.
  const key2 = process.env.EVDS_KEY;
  for (const spec of EVDS_MACRO_CANDIDATES) {
    const s = await evdsSeries(key2, spec.code, "01-01-2023");
    if (!s.length) { console.log(`  [${spec.key}] ${spec.code}: veri yok → atlandı (kod yanlış olabilir, güven: ${spec.conf})`); continue; }
    const last = s[s.length - 1];
    const inRange = last.value >= spec.min && last.value <= spec.max;
    console.log(`  [${spec.key}] ${spec.code}: son=${last.value} (${last.date}) — ${inRange ? "MAKUL ✓" : "ARALIK DIŞI ✗ reddedildi"}`);
    if (!inRange) continue;
    const val = spec.kind === "pct" ? pctStr(last.value)
      : spec.kind === "bnusd" ? (last.value / 1000).toFixed(2).replace(".", ",") + " mlyr $"
      : String(last.value);
    const label = trMonthLabel(last.date) || last.date;
    const row = macro.find((r) => r.event === spec.event);
    if (row) { row.previous = row.actual ?? row.previous; row.actual = val; row.status = "released"; row.date = label; }
    else macro.push({ event: spec.event, actual: val, previous: null, status: "released", date: label, note: "TCMB EVDS", schedule: "EVDS güncellemesine göre" });
  }

  if (cpi.length >= 13 || EVDS_MACRO_CANDIDATES.length) {
    const out = { ...prevStocks, macro };
    await fs.writeFile(path.join(DATA_DIR, "stocks.json"), JSON.stringify(out));
  }
}

async function main() {
  const prevStocks = await readJson("stocks.json", { stocks: [], macro: [] });
  const prevMarkets = await readJson("markets.json", null);
  const prevDetails = await readJson("details.json", {});
  // details are enriched from Yahoo (dividends/eps/earnings) but timeline+name preserved.
  const detailsOut = {};
  const nameMap = {};
  for (const s of prevStocks.stocks || []) nameMap[s.symbol] = s.name;
  const symbols = (prevStocks.stocks || []).map((s) => s.symbol);
  if (!symbols.length) throw new Error("stocks.json boş — sembol listesi yok.");

  // --- Fast intraday-only path (called by refresh-fast.yml every ~2 min) -----
  // Only a batched quote → intraday.json. Skips the slow 1y chart/quoteSummary
  // loop entirely, so it never touches history/fundamentals/news files.
  if (process.env.INTRADAY === "1" || process.argv.includes("--intraday-only")) {
    await refreshIntraday(symbols);
    return;
  }

  // --- News-only path (refresh-news.yml, hourly incl. weekends) --------------
  // Prices don't move when the market is closed, but the press and KAP keep
  // publishing. This fetches only news/marketNews/commodityNews so a weekend
  // reader still gets fresh headlines, without touching prices/history/fundamentals.
  if (process.env.NEWS_ONLY === "1" || process.argv.includes("--news-only")) {
    await refreshNewsOnly(prevStocks);
    return;
  }

  // --- Macro-only path (EVDS): real CPI series + inflation figures ------------
  // Needs EVDS_KEY. Builds cpiHistory.json (monthly TÜFE index, 2021→) which
  // unlocks inflation-adjusted real return in the app, and refreshes the CPI
  // rows in stocks.json.macro. Other series stay on seed until their codes are
  // verified (a wrong code yields nothing and is skipped — never fabricated).
  if (process.env.MACRO_ONLY === "1" || process.argv.includes("--macro-only")) {
    await refreshMacroOnly(prevStocks);
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  // 1) One batched quote call for all snapshots.
  console.log("Fetching quotes for " + symbols.length + " symbols…");
  const yhSymbols = symbols.map((s) => s + ".IS");
  const quotes = {};
  try {
    const arr = await yf.quote(yhSymbols);
    for (const q of Array.isArray(arr) ? arr : [arr]) {
      quotes[(q.symbol || "").replace(".IS", "")] = q;
    }
  } catch (e) {
    console.log("  batch quote failed (" + e.message + "), falling back per-symbol");
  }

  // 2) Per-symbol 1y chart → history + indicators + pivots.
  const stocks = [];
  const technicals = {};
  const pivotsOut = {};
  const history = {};
  const fundamentals = {};
  const prevFundamentals = await readJson("fundamentals.json", {});
  // Fixed early start so the chart archive GROWS over time (≈5y today → ≈10y by 2031).
  // Older-than-1y bars are downsampled to weekly to keep history.json small.
  const HISTORY_START = "2021-01-01";
  const start = HISTORY_START;
  let done = 0;
  const failures = [];

  for (const sym of symbols) {
    done++;
    process.stdout.write("\rHistory/indicators " + done + "/" + symbols.length + " (" + sym + ")     ");
    try {
      const [ch, qs] = await Promise.all([
        yf.chart(sym + ".IS", { period1: start, interval: "1d" }),
        yf.quoteSummary(sym + ".IS", {
          modules: ["summaryDetail", "defaultKeyStatistics", "financialData", "assetProfile", "calendarEvents", "recommendationTrend", "earnings"],
        }).catch(() => null),
      ]);
      if (qs) {
        const sd = qs.summaryDetail || {};
        const ks = qs.defaultKeyStatistics || {};
        const fd = qs.financialData || {};
        const ap = qs.assetProfile || {};
        fundamentals[sym] = {
          sector: mapSector(ap.sector, sym),
          marketCap: sd.marketCap != null ? Math.round(sd.marketCap) : null,
          pe: round(sd.trailingPE, 2),
          pb: round(ks.priceToBook, 2),
          roe: round(fd.returnOnEquity, 4),
          w52low: round(sd.fiftyTwoWeekLow, 2),
          w52high: round(sd.fiftyTwoWeekHigh, 2),
          divYield: round(sd.dividendYield, 4),
          // Third-party 12-month price targets. Reported, never generated here:
          // the panel's own guardrail forbids IT from naming a price, but what
          // brokerages publish is a fact about the market and belongs on the page.
          tgtLow: round(fd.targetLowPrice, 2),
          tgtMean: round(fd.targetMeanPrice, 2),
          tgtHigh: round(fd.targetHighPrice, 2),
          analysts: fd.numberOfAnalystOpinions != null ? Math.round(fd.numberOfAnalystOpinions) : null,
          ...recTrend(qs),
          ...financials(qs, fd),
        };
        { const _dq = checkFundamentals(fundamentals[sym]); if (_dq) fundamentals[sym].dq = _dq; }

        // Enrich details.json (dividend / EPS / earnings) — preserve timeline + name.
        const ce = qs.calendarEvents || {};
        const today = new Date().toISOString().slice(0, 10);
        const earnDates = (ce.earnings && ce.earnings.earningsDate) || [];
        const nextEarn = (Array.isArray(earnDates) ? earnDates : [earnDates])
          .map(isoDate).filter((d) => d && d >= today).sort()[0] || null;
        const lastDivDate = isoDate(ks.lastDividendDate);
        const lastDivVal = ks.lastDividendValue != null ? round(ks.lastDividendValue, 4) : null;
        const prev = prevDetails[sym] || {};
        detailsOut[sym] = {
          symbol: sym,
          name: prev.name || nameMap[sym] || q?.shortName || sym,
          annualDividend: sd.dividendRate != null ? round(sd.dividendRate, 4) : (prev.annualDividend ?? null),
          // The seeded "next" dividend used to be carried forward forever, so it
          // stayed "next" after its date passed (BIMAS: 16 Eylül shown as next on
          // 28 Eylül). Keep it only while it's still ahead.
          nextDividend: prev.nextDividend && prev.nextDividend.date >= today ? prev.nextDividend : null,
          lastDividend: lastDivDate && lastDivVal != null
            ? { date: lastDivDate, amount: lastDivVal }
            : (prev.lastDividend ?? null),
          nextEarningsDate: nextEarn || prev.nextEarningsDate || null,
          epsTtm: ks.trailingEps != null ? round(ks.trailingEps, 4) : (prev.epsTtm ?? null),
          // Re-derive `future` from today on every run — the seed's flags were
          // frozen, so past items stayed "ileri tarihli".
          timeline: (prev.timeline || []).map((t) => ({ ...t, future: t.date >= today })),
        };
      }
      const rows = (ch.quotes || []).filter((r) => r.close != null);
      const closes = rows.map((r) => r.close);
      const q = quotes[sym];
      const price = q?.regularMarketPrice ?? closes[closes.length - 1] ?? null;
      const change = q?.regularMarketChangePercent ?? null;
      const volume = q?.regularMarketVolume ?? rows[rows.length - 1]?.volume ?? null;

      const rsi = rsiWilder(closes);
      stocks.push({
        symbol: sym,
        name: nameMap[sym] || q?.shortName || sym,
        close: round(price, 2),
        change: round(change, 2),
        rsi: round(rsi, 1),
        volume: volume != null ? Math.round(volume) : null,
      });

      const e20 = ema(closes, 20);
      const e50 = ema(closes, 50);
      const sma20v = sma(closes, 20);
      const sd20 = stdev(closes, 20);
      const mac = macd(closes);
      technicals[sym] = {
        price: round(price, 2), sma20: round(sma20v, 2), ema20: round(e20, 2), ema50: round(e50, 2),
        sma50: round(sma(closes, 50), 2), sma200: round(sma(closes, 200), 2),
        bbUpper: sma20v != null && sd20 != null ? round(sma20v + 2 * sd20, 2) : null,
        bbLower: sma20v != null && sd20 != null ? round(sma20v - 2 * sd20, 2) : null,
        cross: detectCross(closes),
        rsi: round(rsi, 1), macd: mac ? round(mac.macd, 3) : null,
        macdSignal: mac ? round(mac.signal, 3) : null, macdHist: mac ? round(mac.hist, 3) : null,
        trend: trendFrom(price, e20, e50),
      };

      const prev = rows.filter((r) => r.date.toISOString().slice(0, 10) < todayStr);
      const base = prev[prev.length - 1] || rows[rows.length - 1];
      if (base && base.high != null && base.low != null && base.close != null) {
        const p = pivots(base.high, base.low, base.close);
        pivotsOut[sym] = {
          pp: round(p.pp, 2), s1: round(p.s1, 2), s2: round(p.s2, 2), s3: round(p.s3, 2),
          r1: round(p.r1, 2), r2: round(p.r2, 2), r3: round(p.r3, 2),
        };
      }

      const hrowsAll = rows.filter((r) => r.open != null && r.high != null && r.low != null && r.close != null);
      const hrows = downsampleHistory(hrowsAll);
      if (hrows.length >= 2) {
        const dts = hrows.map((r) => r.date.toISOString().slice(0, 10));
        history[sym] = {
          s: dts[0], e: dts[dts.length - 1], d: dts,
          o: hrows.map((r) => round(r.open, 2)), h: hrows.map((r) => round(r.high, 2)),
          l: hrows.map((r) => round(r.low, 2)), c: hrows.map((r) => round(r.close, 2)),
          v: hrows.map((r) => (r.volume != null ? Math.round(r.volume) : null)),
        };
      }
    } catch (e) {
      failures.push(sym);
      // keep a minimal row from the quote if chart failed
      const q = quotes[sym];
      if (q?.regularMarketPrice != null) {
        stocks.push({
          symbol: sym, name: nameMap[sym] || sym,
          close: round(q.regularMarketPrice, 2), change: round(q.regularMarketChangePercent, 2),
          rsi: null, volume: q.regularMarketVolume != null ? Math.round(q.regularMarketVolume) : null,
        });
      }
    }
  }
  process.stdout.write("\n");
  if (failures.length) console.log("⚠ chart failed for: " + failures.join(", "));

  // 3) Markets.
  console.log("Fetching markets (FX + gold)…");
  const markets = await fetchMarkets(prevMarkets);

  // 3a) FX history — lets the app redraw any chart in USD/EUR/GBP/gram gold.
  console.log("Fetching FX history…");
  const fxHistory = await fetchFxHistory(HISTORY_START);

  console.log("Fetching index history…");
  const indices = await fetchIndexHistory(HISTORY_START);

  // 3b) KAP disclosures (news) — for the FULL BIST universe, so non-100 favourites
  // (e.g. SELEC) also get their official KAP filings, not just the core 100.
  console.log("Fetching KAP disclosures…");
  const prevNews = await readJson("news.json", {});
  const uniSeedForNews = await readJson("universe-seed.json", []);
  const newsSymbols = [...new Set([...symbols, ...uniSeedForNews.map((s) => s.symbol)])];
  const news = await fetchNews(newsSymbols, prevNews);

  // 3c) Market news from the press (Google News RSS, hourly).
  console.log("Fetching market news (Google News)…");
  const prevMarketNews = await readJson("marketNews.json", { updatedAt: null, items: {} });
  const marketNews = await fetchMarketNews(stocks, prevMarketNews);
  if (marketNews.skipped) console.log("  (market news atlandı — saat başı çalışır)");
  // 3c0) Article summaries — fetch the piece and keep its opening paragraphs
  // (real lede, no LLM, no fabrication). Only for items with a DIRECTLY fetchable
  // URL still missing a summary (KAP disclosures + any direct press link); Google
  // News redirect shells are skipped, so those keep the related-headlines fallback.
  if (news && news !== prevNews) {
    process.stdout.write("KAP özetleri çekiliyor… ");
    console.log((await enrichSummaries(news, { cap: 30 })) + " eklendi");
  }
  if (!marketNews.skipped) {
    process.stdout.write("Haber özetleri çekiliyor… ");
    console.log((await enrichSummaries(marketNews.items, { press: true })) + " eklendi");
  }

  // 3c1) Commodity news (gold/silver/platinum/palladium/copper), same hourly gate.
  console.log("Fetching commodity news…");
  const prevCommodityNews = await readJson("commodityNews.json", { updatedAt: null, items: {} });
  const commodityNews = await fetchCommodityNews(prevCommodityNews);
  if (commodityNews.skipped) console.log("  (emtia haberi atlandı — saat başı çalışır)");

  // 3c2) Extended tier for every non-core symbol (FULL=1 / --full only).
  const wantFull = process.env.FULL === "1" || process.argv.includes("--full");
  let extended = null;
  if (wantFull) {
    console.log("Fetching extended tier (non-100 charts + indicators)…");
    extended = await buildExtended(symbols);
  } else {
    console.log("Extended tier atlandı (FULL=1 ile çalıştır).");
  }

  // 3d) Full BIST universe (light price+change) for search beyond BIST 100.
  console.log("Fetching universe (all BIST light)…");
  const universe = await fetchUniverse(stocks);

  // 4) Write — fast data fresh; details/news preserved (change slowly).
  const updatedAt = new Date().toISOString();
  // details: keep previously-seeded entries for any symbol Yahoo didn't return.
  const details = { ...prevDetails };
  for (const [sym, d] of Object.entries(detailsOut)) details[sym] = d;
  await fs.writeFile(path.join(DATA_DIR, "details.json"), JSON.stringify(details));
  await fs.writeFile(path.join(DATA_DIR, "stocks.json"), JSON.stringify({ updatedAt, stocks, macro: prevStocks.macro || [] }));
  await fs.writeFile(path.join(DATA_DIR, "technicals.json"), JSON.stringify(technicals));
  await fs.writeFile(path.join(DATA_DIR, "pivots.json"), JSON.stringify(pivotsOut));
  await fs.writeFile(path.join(DATA_DIR, "history.json"), JSON.stringify(history));
  // Merge: a symbol Yahoo didn't return this run keeps its previous entry rather
  // than disappearing from the app (fundamentals write used to fully overwrite).
  const mergedFund = { ...prevFundamentals, ...fundamentals };
  await fs.writeFile(path.join(DATA_DIR, "fundamentals.json"), JSON.stringify(mergedFund));
  if (universe) await fs.writeFile(path.join(DATA_DIR, "universe.json"), JSON.stringify(universe));
  // Extended files are only rewritten on a FULL run — a fast run must never
  // blank them out.
  if (extended) {
    await fs.writeFile(path.join(DATA_DIR, "technicalsExt.json"), JSON.stringify(extended.technicals));
    await fs.writeFile(path.join(DATA_DIR, "pivotsExt.json"), JSON.stringify(extended.pivots));
    await fs.writeFile(path.join(DATA_DIR, "historyExt.json"), JSON.stringify(extended.history));
    await fs.writeFile(path.join(DATA_DIR, "fundamentalsExt.json"), JSON.stringify(extended.fundamentals));
    await fs.writeFile(path.join(DATA_DIR, "detailsExt.json"), JSON.stringify(extended.details));
    console.log("  extended dosyaları yazıldı: " + Object.keys(extended.history).length + " sembol");
  }
  await fs.writeFile(path.join(DATA_DIR, "markets.json"), JSON.stringify({ updatedAt, ...markets }));
  // Only overwrite when the fetch actually worked — a failed run must not blank
  // the series and silently break every foreign-currency chart.
  if (fxHistory && fxHistory.USD && fxHistory.USD.c.length > 100) {
    await fs.writeFile(path.join(DATA_DIR, "fxHistory.json"), JSON.stringify(fxHistory));
    console.log("  fxHistory: " + Object.keys(fxHistory).join(", ") + " · " + fxHistory.USD.c.length + " gün");
  }
  if (indices && Object.keys(indices).length) {
    await fs.writeFile(path.join(DATA_DIR, "indices.json"), JSON.stringify(indices));
    console.log("  indices: " + Object.keys(indices).map((k) => k + " " + indices[k].c.length + "g").join(", "));
  }
  const newsCount = Object.keys(news).length;
  // only overwrite news.json if we actually got fresh data (fetchNews returns prevNews on failure)
  {
    const kapText = await enrichKapText(news, await readJson("kapText.json", {}));
    await fs.writeFile(path.join(DATA_DIR, "kapText.json"), JSON.stringify(kapText));
  }
  if (news !== prevNews) await fs.writeFile(path.join(DATA_DIR, "news.json"), JSON.stringify(news));
  const mnItems = marketNews.items || {};
  await fs.writeFile(path.join(DATA_DIR, "marketNews.json"), JSON.stringify({ updatedAt: marketNews.updatedAt, items: mnItems }));
  const mnCount = Object.values(mnItems).filter((a) => a && a.length).length;
  const cnItems = commodityNews.items || {};
  await fs.writeFile(path.join(DATA_DIR, "commodityNews.json"), JSON.stringify({ updatedAt: commodityNews.updatedAt, items: cnItems }));

  console.log(
    "Wrote (cloud/yahoo):\n  stocks " + stocks.length + " · technicals " + Object.keys(technicals).length +
    " · pivots " + Object.keys(pivotsOut).length + " · history " + Object.keys(history).length +
    " · fundamentals " + Object.keys(fundamentals).length +
    " · fx " + markets.fx.length + " · KAP-news " + newsCount + " · piyasa-haber " + mnCount + " · details " + Object.keys(details).length +
    "\n  (macro korundu)\n  updatedAt " + updatedAt,
  );
}

main().catch((e) => { console.error("\nrefresh-cloud failed:", e); process.exit(1); });
