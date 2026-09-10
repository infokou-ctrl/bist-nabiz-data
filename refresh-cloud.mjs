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
function mapSector(s) {
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
      out[code].push({ title, date, url });
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
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

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
    const link = pick("link");
    const pub = pick("pubDate");
    // Google News titles are "Headline - Source"; drop the trailing source.
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    // Keep the full publish timestamp (ISO) so the UI can show the news TIME.
    let date = null;
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) date = d.toISOString(); }
    if (!title || title === "Google Haberler" || !link) continue;
    items.push({ title, date, url: link, source: source || null });
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
    out[sym] = items.filter((n) => rel(n.title || ""));
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
// BIST 50 is intentionally omitted: Yahoo has no usable history for XU050 (one
// day only), and a chart built from a single point would be a lie.
async function fetchIndexHistory(startDate) {
  const defs = [
    { code: "XU100", yh: "XU100.IS", label: "BIST 100" },
    { code: "XU030", yh: "XU030.IS", label: "BIST 30" },
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

    // Gram gold in TRY = (gold USD/oz on that day) × (USDTRY that day) / 31.1034768
    try {
      const gold = await series("GC=F");
      const usdBy = new Map(usd.d.map((d, i) => [d, usd.c[i]]));
      const d = [], c = [];
      for (let i = 0; i < gold.d.length; i++) {
        const rate = usdBy.get(gold.d[i]);
        if (rate == null) continue; // no FX print that day — skip rather than guess
        d.push(gold.d[i]);
        c.push(round((gold.c[i] * rate) / 31.1034768, 2));
      }
      if (d.length > 30) out.XAU = { d, c };
    } catch { /* gold history optional */ }
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
  // gram altın ≈ (gold USD/oz) × USDTRY / 31.1034768
  try {
    const g = await yf.quote("GC=F");
    if (g.regularMarketPrice && usdtry) {
      fx.push({
        symbol: "gram-altin", label: "Gram Altın",
        value: round((g.regularMarketPrice * usdtry) / 31.1034768, 2),
        change: round(g.regularMarketChangePercent, 2),
      });
    }
  } catch { /* skip gold */ }
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
      history[sym] = { s: dts[0], e: dts[dts.length - 1], d: dts, c: closes.map((c) => round(c, 2)) };

      if (qs) {
        const sd = qs.summaryDetail || {}, ks = qs.defaultKeyStatistics || {};
        const fd = qs.financialData || {}, ap = qs.assetProfile || {};
        fundamentals[sym] = {
          sector: mapSector(ap.sector),
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
          sector: mapSector(ap.sector),
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
          nextDividend: prev.nextDividend ?? null,
          lastDividend: lastDivDate && lastDivVal != null
            ? { date: lastDivDate, amount: lastDivVal }
            : (prev.lastDividend ?? null),
          nextEarningsDate: nextEarn || prev.nextEarningsDate || null,
          epsTtm: ks.trailingEps != null ? round(ks.trailingEps, 4) : (prev.epsTtm ?? null),
          timeline: prev.timeline || [],
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
  if (news !== prevNews) await fs.writeFile(path.join(DATA_DIR, "news.json"), JSON.stringify(news));
  const mnItems = marketNews.items || {};
  await fs.writeFile(path.join(DATA_DIR, "marketNews.json"), JSON.stringify({ updatedAt: marketNews.updatedAt, items: mnItems }));
  const mnCount = Object.values(mnItems).filter((a) => a && a.length).length;

  console.log(
    "Wrote (cloud/yahoo):\n  stocks " + stocks.length + " · technicals " + Object.keys(technicals).length +
    " · pivots " + Object.keys(pivotsOut).length + " · history " + Object.keys(history).length +
    " · fundamentals " + Object.keys(fundamentals).length +
    " · fx " + markets.fx.length + " · KAP-news " + newsCount + " · piyasa-haber " + mnCount + " · details " + Object.keys(details).length +
    "\n  (macro korundu)\n  updatedAt " + updatedAt,
  );
}

main().catch((e) => { console.error("\nrefresh-cloud failed:", e); process.exit(1); });
