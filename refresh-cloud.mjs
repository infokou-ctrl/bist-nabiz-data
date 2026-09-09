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

async function fetchMarketNews(stocks, prev) {
  const prevItems = (prev && prev.items) || {};
  // Gate: only run when the CI wall-clock is in the first quarter-hour (≈ hourly),
  // to avoid 100 Google requests every 15 min. Local manual runs (FORCE) bypass.
  const force = process.env.FORCE_NEWS === "1";
  if (!force && new Date().getUTCMinutes() >= 15) {
    return { updatedAt: (prev && prev.updatedAt) || null, items: prevItems, skipped: true };
  }
  const out = {};
  for (const [sym, items] of Object.entries(prevItems)) out[sym] = items.slice();
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
    // Precision: keep only headlines that actually name THIS company (name/brand),
    // or carry its ticker as a whole latin word — drops generic "Borsa'da bugün /
    // faiz kararı" items that merely matched a finance keyword.
    const norm = (x) => x.toLocaleLowerCase("tr").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    const nName = norm(name), nNs = norm(ns);
    const tickerRe = new RegExp("\\b" + s.symbol + "\\b", "i");
    const relevant = (title) => {
      const t = norm(title);
      return (nName.length >= 4 && t.includes(nName)) ||
        (nNs !== nName && nNs.length >= 4 && t.includes(nNs)) ||
        tickerRe.test(title);
    };
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
          modules: ["summaryDetail", "defaultKeyStatistics", "financialData", "assetProfile", "calendarEvents"],
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

  // 3b) KAP disclosures (news).
  console.log("Fetching KAP disclosures…");
  const prevNews = await readJson("news.json", {});
  const news = await fetchNews(symbols, prevNews);

  // 3c) Market news from the press (Google News RSS, hourly).
  console.log("Fetching market news (Google News)…");
  const prevMarketNews = await readJson("marketNews.json", { updatedAt: null, items: {} });
  const marketNews = await fetchMarketNews(stocks, prevMarketNews);
  if (marketNews.skipped) console.log("  (market news atlandı — saat başı çalışır)");

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
  await fs.writeFile(path.join(DATA_DIR, "fundamentals.json"), JSON.stringify(fundamentals));
  if (universe) await fs.writeFile(path.join(DATA_DIR, "universe.json"), JSON.stringify(universe));
  await fs.writeFile(path.join(DATA_DIR, "markets.json"), JSON.stringify({ updatedAt, ...markets }));
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
