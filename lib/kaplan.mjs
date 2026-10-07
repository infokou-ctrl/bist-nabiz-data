// Kaplan — panelin açıklayıcı analisti.
//
// Ne yapar: sert fiyat hareketlerini (taban/tavan dahil) bulur, aynı aralıkta
// yayımlanan KAP bildirimlerini ve basın haberlerini SEBEP TÜRÜNE göre
// sınıflandırır (TMSF/BDDK müdahalesi, borsa tedbiri, bedelsiz, pay alım
// teklifi, toplu yönetici istifası…), grup bağlarını (aynı grubun hisseleri,
// bildirimde adı geçen şirketler) kurar ve hissenin KENDİ geçmişinde benzer
// sert günlerden sonra ne olduğunu sayar. Her koşuda yeni olaylar bir vaka
// arşivine yazılır; sonraki 1/5/20 seansın getirisi geldikçe doldurulur —
// arşiv büyüdükçe "bu tür olaylardan sonra ne oldu" istatistiği zenginleşir.
//
// Ne yapmaz (Guardrail): al / sat / tut demez, hedef fiyat ya da tahmin vermez.
// Uydurmaz: her sebep gerçek bir bildirime/habere bağlıdır; bulamazsa
// "açıklama bulunamadı" der.
//
// ANTHROPIC_API_KEY varsa, öncelikli olaylar için anlatımı Claude yazar —
// yalnızca verilen kaynaklara dayanarak; yoksa kurallı anlatım kullanılır.

import fs from "node:fs/promises";
import path from "node:path";

const fold = (s) => (s || "").toLocaleLowerCase("tr-TR");

// ---- sebep türleri ----------------------------------------------------------
// w: ağırlık (aynı aralıkta birden çok tür varsa en ağırı "olası sebep" olur).
// Desenler tr-TR küçük harfe çevrilmiş metinde aranır.
export const CATS = [
  { key: "regulator", w: 10, label: "Düzenleyici kurum müdahalesi (TMSF/BDDK/SPK)",
    re: /tmsf|tasarruf mevduatı sigorta|bddk|bankacılık düzenleme|ortaklık haklarının[^.]{0,80}kullanılma|kayyum|el kon|faaliyet izn[^.]{0,30}(iptal|kaldır)|spk[^.]{0,60}(tedbir|suç duyurusu|işlem yasağı)/ },
  { key: "insolvency", w: 9, label: "Konkordato / iflas / tasfiye",
    re: /konkordato|iflas|tasfiye|haciz/ },
  { key: "debt", w: 8, label: "Borç yapılandırma / finansal sıkıntı",
    re: /borç[^.]{0,60}yapılandır|finansal yeniden yapılandırma|temerrüt|ödeme güçlüğü|vadesinde ödene/ },
  { key: "tedbir", w: 8, label: "Borsa tedbiri (brüt takas, kredili işlem yasağı, tek fiyat)",
    re: /brüt takas|kredili işlem|açığa satış yasağı|tek fiyat|emir paketi|volatilite bazlı tedbir|vbts|geçici durdur|işlem sırası[^.]{0,20}kapat|piyasa bozucu/ },
  { key: "tender", w: 7, label: "Pay alım teklifi",
    re: /pay alım teklif|çağrı yoluyla/ },
  { key: "legal", w: 6, label: "Soruşturma / dava / ceza",
    re: /soruşturma|gözaltı|operasyon|dava aç|davası|suç duyurusu|vergi incelemesi|idari para cezası/ },
  { key: "control", w: 6, label: "Ortaklık değişikliği, birleşme, satın alma",
    re: /pay devri|hisse devri|payların devr|devralma|birleşme|kontrol değişikliği|hakim ortak|satın alın|satın alma/ },
  { key: "bonus", w: 6, label: "Bedelsiz sermaye artırımı / bölünme",
    re: /bedelsiz|pay bölünme/ },
  { key: "rights", w: 6, label: "Bedelli sermaye artırımı / hak kullanımı",
    re: /bedelli|hak kullanım/ },
  { key: "earnings", w: 5, label: "Finansal sonuçlar (bilanço)",
    re: /finansal rapor|finansal tablo|bilanço|faaliyet raporu|net kâr|net kar|net zarar/ },
  { key: "contract", w: 5, label: "Yeni iş / sözleşme / ihale",
    re: /sözleşme imza|sözleşmesi imza|ihale|sipariş|iş ilişkisi|anlaşma imza/ },
  { key: "dividend", w: 4, label: "Kâr payı (temettü)",
    re: /kâr payı|kar payı|temettü/ },
  { key: "index", w: 5, label: "Endeks değişikliği",
    re: /endeks(?:ler)?(?:i|in)?(?:den|ten) çıkar|endekse (?:alın|dahil|ekle)/ },
  { key: "unusual", w: 3, label: "Borsa'nın olağan dışı hareket sorusu",
    re: /olağan dışı fiyat|olağandışı fiyat|fiyat ve miktar hareket/ },
  { key: "buyback", w: 3, label: "Pay geri alımı",
    re: /geri alım|geri alın/ },
  { key: "rating", w: 3, label: "Kredi derecelendirmesi",
    re: /derecelendirme|kredi notu/ },
  { key: "mgmt", w: 2, label: "Yönetimde ayrılma / atama",
    re: /istifa|görevden ayrıl|görevinden ayrıl|görevden alın/ },
];
const CAT_BY_KEY = Object.fromEntries(CATS.map((c) => [c.key, c]));
// Toplu ayrılma: 7 gün içinde ≥3 yönetici ayrılığı tek başına güçlü bir işarettir.
const MGMT_WAVE = { key: "mgmtWave", w: 7, label: "Yönetimde toplu ayrılma" };
CAT_BY_KEY.mgmtWave = MGMT_WAVE;

// Her gün dosyalanan, hisseyi açıklamayan rutin bildirimler (moveNews.ts ile aynı küme).
const ROUTINE_KAP = /pay dışında sermaye piyasası aracı|finansman bonosu|kira sertifikası|borçlanma aracı|kupon ödeme|itfa|fon toplam değer|varlığa dayalı|ihraç tavanı|varant|yatırım kuruluşu|genel bilgi formu|kurumsal yönetim|komiteleri|sorumluluk beyanı/;
const PRESS_NOISE = /canlı grafik|hisse senedi fiyatı|anlık fiyat|canlı borsa|ne kadar|kaç tl|günlük teknik analiz|teknik analiz|hedef fiyat|al-sat|destek ve direnç/;

export function classify(text) {
  const t = fold(text);
  const out = [];
  for (const c of CATS) if (c.re.test(t)) out.push(c.key);
  return out;
}

// ---- seri yardımcıları --------------------------------------------------------
// history.json'ın eski kısmı haftalık; yalnızca günlük kuyruk kullanılır
// (art arda iki kayıt arası ≤5 gün).
export function dailyTail(d, c) {
  if (!d || !c || d.length < 2) return { d: [], c: [] };
  let start = d.length - 1;
  for (let i = d.length - 1; i > 0; i--) {
    const gap = (Date.parse(d[i]) - Date.parse(d[i - 1])) / 864e5;
    if (gap > 5) break;
    start = i - 1;
  }
  return { d: d.slice(start), c: c.slice(start) };
}

const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (a, b) => (a > 0 && b > 0 ? (b / a - 1) * 100 : null);

// Hissenin kendi geçmişinde benzer sert günler ve sonrasında ne olduğu.
// `exclude` son N kayıt (incelenen olayın kendisi ve hemen öncesi) dışarıda kalır.
export function ownAnalog(series, dir, minAbs, exclude = 25) {
  const { c } = series;
  const f1 = [], f5 = [], f20 = [];
  let n = 0;
  for (let i = 1; i < c.length - exclude; i++) {
    const r = pct(c[i - 1], c[i]);
    if (r == null || (dir > 0 ? r < minAbs : r > -minAbs)) continue;
    n++;
    if (i + 1 < c.length) f1.push(pct(c[i], c[i + 1]));
    if (i + 5 < c.length) f5.push(pct(c[i], c[i + 5]));
    if (i + 20 < c.length) f20.push(pct(c[i], c[i + 20]));
  }
  if (n < 3) return null;
  const up = (a) => (a.length ? Math.round((a.filter((x) => x > 0).length / a.length) * 100) : null);
  return {
    n, min: minAbs,
    f1: r1(median(f1)), f5: r1(median(f5)), f20: r1(median(f20)),
    up5: up(f5), up20: up(f20), n20: f20.length,
  };
}

function volatility(series, n = 60) {
  const { c } = series;
  const rs = [];
  for (let i = Math.max(1, c.length - n); i < c.length; i++) {
    const r = pct(c[i - 1], c[i]);
    if (r != null) rs.push(r);
  }
  if (rs.length < 20) return null;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1));
}

function limitDays(series, days = 250) {
  const { c } = series;
  let up = 0, down = 0;
  for (let i = Math.max(1, c.length - days); i < c.length; i++) {
    const r = pct(c[i - 1], c[i]);
    if (r == null) continue;
    if (r >= 9.5) up++;
    else if (r <= -9.5) down++;
  }
  return { up, down };
}

// ---- grup bağları ---------------------------------------------------------------
// Şirket adının ilk kelimesi birden çok hissede ortaksa (TERA → TERA, TEHOL,
// TRHOL) bir "grup" sayılır. Genel kelimeler grup değildir.
const GROUP_STOP = new Set(["türk", "türkiye", "anadolu", "ege", "istanbul", "akdeniz", "marmara", "doğu", "batı",
  "kuzey", "güney", "global", "dünya", "avrasya", "yeni", "net", "park", "eko", "mega", "orta", "pera", "ata",
  "ak", "gen", "ana", "bir", "the", "int", "inter", "mavi", "yatırım", "enerji", "gayrimenkul", "holding",
  "finans", "yapı", "kimya", "tekstil", "gıda", "çelik", "egeli"]);
const nameWords = (n) => fold(n).replace(/[^\p{L}\d ]/gu, " ").split(/\s+/).filter(Boolean);

export function buildGroups(universe) {
  const by = new Map();
  for (const u of universe) {
    const w = nameWords(u.name)[0];
    if (!w || w.length < 3 || GROUP_STOP.has(w)) continue;
    if (!by.has(w)) by.set(w, []);
    by.get(w).push(u.symbol);
  }
  const groupOf = {};
  for (const [w, syms] of by) if (syms.length >= 2 && syms.length <= 8) for (const s of syms) groupOf[s] = w;
  return { groupOf, members: Object.fromEntries([...by].filter(([, s]) => s.length >= 2 && s.length <= 8)) };
}

// Bildirim metninde adı geçen DİĞER listeli şirketler (ilk iki kelime, ≥9 harf).
export function buildMentionIndex(universe) {
  const keys = [];
  for (const u of universe) {
    const w = nameWords(u.name);
    if (w.length < 2) continue;
    const k = w[0] + " " + w[1];
    if (k.length >= 9) keys.push([k, u.symbol]);
  }
  return (text, self) => {
    const t = fold(text).replace(/[^\p{L}\d ]/gu, " ").replace(/\s+/g, " ");
    const out = new Set();
    for (const [k, s] of keys) if (s !== self && t.includes(k)) out.add(s);
    return [...out];
  };
}

// ---- yardımcılar: tarih ---------------------------------------------------------
const istDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- ana hesap ------------------------------------------------------------------
export function computeKaplan(input, prevCases = {}) {
  const { stocks, universe, history, historyExt, news, kapText, marketNews, indices, fundamentals, fundamentalsExt } = input;
  const nameOf = Object.fromEntries(universe.map((u) => [u.symbol, u.name]));
  for (const s of stocks.stocks || []) nameOf[s.symbol] = s.name;
  const core = new Set((stocks.stocks || []).map((s) => s.symbol));
  const sectorOf = (s) => (fundamentals[s] || fundamentalsExt[s] || {}).sector || null;

  // İşlem günü takvimi: XU100 günleri (+ bugünün seansı, endeks dosyası gecikmişse).
  const cal = (indices.XU100?.d || []).slice();
  const xuC = (indices.XU100?.c || []).slice();
  const stampTr = stocks.updatedAt ? istDate(Date.parse(stocks.updatedAt)) : null;
  const hourTr = stocks.updatedAt ? (new Date(stocks.updatedAt).getUTCHours() + 3) % 24 : 0;
  const session = stampTr && hourTr >= 10 && stampTr > (cal.at(-1) || "") && ![0, 6].includes(new Date(stampTr + "T12:00:00Z").getUTCDay())
    ? stampTr : cal.at(-1);
  if (session && session !== cal.at(-1)) { cal.push(session); xuC.push(indices.XU100?.value ?? null); }
  const xuChg = {};
  for (let i = 1; i < cal.length; i++) xuChg[cal[i]] = r1(pct(xuC[i - 1], xuC[i]));
  if (session && indices.XU100?.change != null && session === indices.XU100.d?.at(-1)) xuChg[session] = r1(indices.XU100.change);
  const WINDOW = 22; // son ~1 ay seans
  const recent = cal.slice(-WINDOW);
  const prevOf = Object.fromEntries(cal.map((d, i) => [d, cal[i - 1] || addDays(d, -1)]));

  // Günlük kapanış serileri (bugünün fiyatı universe/stocks'tan eklenir).
  const live = Object.fromEntries(universe.map((u) => [u.symbol, u]));
  for (const s of stocks.stocks || []) live[s.symbol] = s;
  const series = {};
  for (const sym of Object.keys(live)) {
    const h = history[sym] || historyExt[sym];
    let d = [], c = [];
    if (h) ({ d, c } = dailyTail(h.d, h.c));
    d = d.slice(); c = c.slice();
    const lv = live[sym];
    if (session && lv && lv.close > 0 && (d.at(-1) || "") < session) {
      // Seri bugünden önce bitiyor (genişletilmiş katman günde bir yenilenir):
      // bugünün kapanışını ekle. Seri bir önceki seanstan da önce bitiyorsa önceki
      // kapanışı bugünün değişiminden geri hesapla — yoksa iki seansın hareketi
      // tek güne yığılır (TERA 2 Ekim → 6 Ekim "%-18,9").
      const prev = prevOf[session];
      if ((d.at(-1) || "") < prev) {
        if (!isFinite(lv.change)) { d = []; c = []; }
        else { d.push(prev); c.push(lv.close / (1 + lv.change / 100)); }
      }
      d.push(session); c.push(lv.close);
    }
    if (c.length >= 2) series[sym] = { d, c };
  }

  // Belgeler: KAP (+gövde metni) ve basın, hisse başına.
  const docsOf = (sym) => {
    const out = [];
    for (const k of news[sym] || []) {
      if (!k.title || ROUTINE_KAP.test(fold(k.title))) continue;
      const id = (k.url || "").match(/(\d+)$/)?.[1];
      const body = id && kapText[id] ? kapText[id].t || "" : "";
      out.push({ kind: "kap", t: k.title, u: k.url || null, d: (k.date || "").slice(0, 10), body });
    }
    for (const p of marketNews[sym] || []) {
      if (!p.title || !p.date || PRESS_NOISE.test(fold(p.title))) continue;
      const ms = Date.parse(p.date);
      if (isNaN(ms)) continue;
      // 18:00 sonrası haber ertesi seansa sayılır.
      const day = istDate(ms);
      const late = (new Date(ms).getUTCHours() + 3) % 24 >= 18;
      out.push({ kind: "press", t: p.title, u: p.url || null, d: late ? addDays(day, 1) : day, src: p.source || null, body: p.summary || "" });
    }
    for (const o of out) o.cats = classify(o.t + " " + o.body);
    return out;
  };

  const groups = buildGroups(universe);
  const mentions = buildMentionIndex(universe);

  const moves = {};   // sym → olay listesi (yeniden eskiye)
  const profiles = {};
  const byDay = {};   // tarih → [{sym, chg}]
  const docCache = {};
  const getDocs = (s) => (docCache[s] ||= docsOf(s));

  for (const [sym, ser] of Object.entries(series)) {
    const sig = volatility(ser);
    const lim = limitDays(ser);
    profiles[sym] = { sig: r1(sig), lu: lim.up, ld: lim.down, n: ser.c.length };
    const minMove = core.has(sym) ? 4 : 5;
    const thr = Math.max(minMove, sig ? 3 * sig : minMove);
    for (let i = Math.max(1, ser.d.length - WINDOW); i < ser.d.length; i++) {
      const d = ser.d[i];
      if (!recent.includes(d)) continue;
      const chg = pct(ser.c[i - 1], ser.c[i]);
      if (chg == null) continue;
      const limit = chg >= 9.5 ? "tavan" : chg <= -9.5 ? "taban" : null;
      if (!limit && Math.abs(chg) < thr) continue;
      // Seri: bir önceki seans da aynı yönde sert hareket ettiyse bu, serinin kaçıncı günü.
      const last = (moves[sym] || []).at(-1);
      const run = last && last.i === i - 1 && Math.sign(last.chg) === Math.sign(chg) ? last.run + 1 : 1;
      (moves[sym] ||= []).push({ d, chg: r1(chg), limit, i, run });
      (byDay[d] ||= []).push({ sym, chg });
    }
  }

  // Grup kümeleri: aynı gün aynı yönde sert hareket eden grup üyeleri.
  const themes = [];
  for (const [d, list] of Object.entries(byDay)) {
    const g = {};
    for (const m of list) {
      const key = groups.groupOf[m.sym];
      if (!key) continue;
      const dir = m.chg > 0 ? 1 : -1;
      (g[key + dir] ||= { key, dir, syms: [] }).syms.push(m.sym);
    }
    for (const t of Object.values(g)) if (t.syms.length >= 2) themes.push({ d, group: t.key, dir: t.dir, syms: t.syms });
  }

  // Sebep sayılacak en düşük ağırlık. Pay geri alımı, kredi notu, tekil istifa
  // sert bir hareketi açıklamaz (geri alım çoğu zaman düşüşe TEPKİDİR) — yalnızca
  // "aynı aralıktaki diğer bildirimler" olarak listelenir.
  const CAUSE_MIN = 4;
  const strong = (c) => c && (CAT_BY_KEY[c]?.w || 0) >= 6;
  const topCat = (cats) => cats.slice().sort((a, b) => CAT_BY_KEY[b].w - CAT_BY_KEY[a].w)[0];

  // Ters atıf dizini: son 14 günde X'in bildiriminde Y'nin adı geçiyorsa Y → [X'in belgesi].
  const mentionedBy = {};
  const lastDay = recent.at(-1) || session;
  for (const sym of Object.keys(news)) {
    for (const x of getDocs(sym)) {
      if (x.d < addDays(lastDay, -21)) continue;
      for (const s of mentionsOf(x, sym)) (mentionedBy[s] ||= []).push({ by: sym, x });
    }
  }

  // Liste haberleri (endeks değişiklikleri, "günün en çok yükselenleri"…) onlarca
  // şirketi anar ve sahte bağ kurar: 4'ten fazla şirket anan belge bağ kurmaz.
  function mentionsOf(x, self) {
    const key = "_m_" + self;
    if (!x[key]) { const l = mentions(x.t + " " + x.body, self); x[key] = l.length > 4 ? [] : l; }
    return x[key];
  }

  // 1. geçiş: her olayın kendi bildirim/haberlerinden sebebi.
  for (const [sym, list] of Object.entries(moves)) {
    const docs = getDocs(sym);
    for (const mv of list) {
      const from = prevOf[mv.d] || addDays(mv.d, -1);
      const win = docs.filter((x) => x.d >= from && x.d <= mv.d);
      const scored = [];
      for (const x of win) for (const c of x.cats) scored.push({ c, w: CAT_BY_KEY[c].w * (x.kind === "kap" ? 1 : 0.6), x });
      const mg = docs.filter((x) => x.kind === "kap" && x.cats.includes("mgmt") && x.d <= mv.d && x.d >= addDays(mv.d, -7));
      if (mg.length >= 3) scored.push({ c: "mgmtWave", w: MGMT_WAVE.w, x: mg[0], n: mg.length });
      scored.sort((a, b) => b.w - a.w);
      const top = scored[0] && scored[0].w >= CAUSE_MIN ? scored[0] : null;
      // Sebep yoksa: son 7 günde güçlü bir gelişme (gecikmeli tepki / işlem durdurma sonrası ilk seans).
      let lead = null;
      if (!top) {
        const back = docs.filter((x) => x.d < from && x.d >= addDays(mv.d, -7) && x.cats.some((c) => CAT_BY_KEY[c].w >= 6));
        if (back.length) lead = { c: topCat(back[0].cats), d: back[0].d, t: back[0].t, u: back[0].u };
      }
      const refs = [];
      const pushRef = (x) => { if (x && !refs.some((r) => r.u === x.u && r.t === x.t)) refs.push({ k: x.kind, t: x.t, u: x.u, d: x.d, s: x.src || null }); };
      if (top) pushRef(top.x);
      for (const sc of scored) if (refs.length < 3) pushRef(sc.x);
      for (const x of win) if (refs.length < 4) pushRef(x);
      Object.assign(mv, {
        cause: top ? top.c : null,
        conf: !top ? 0 : top.x.kind === "kap" ? 2 : 1,
        nWave: top && top.c === "mgmtWave" ? top.n : undefined,
        minor: [...new Set(scored.filter((sc) => sc.w < CAUSE_MIN).map((sc) => sc.c))].slice(0, 3),
        lead, refs: refs.slice(0, 4),
        xu: xuChg[mv.d] ?? null, sec: sectorOf(sym),
      });
    }
  }

  // Seri mirası: taban/tavan serisinin sonraki günleri, sebebi yoksa serinin
  // içindeki (ya da başlangıcındaki) en güçlü sebebi taşır — ANELE'nin 19 günlük
  // taban serisi, 30 Eylül'deki borç yapılandırma bildirimine bağlanır.
  for (const list of Object.values(moves)) {
    const asc = list.slice().sort((a, b) => (a.d < b.d ? -1 : 1));
    let best = null;
    for (const mv of asc) {
      if (mv.run === 1) best = null;
      const own = mv.cause ? { c: mv.cause, d: mv.d, t: mv.refs[0]?.t, u: mv.refs[0]?.u } : mv.lead;
      if (own && (!best || CAT_BY_KEY[own.c].w > CAT_BY_KEY[best.c].w)) best = own;
      if (!mv.cause && !mv.lead && best && mv.run > 1) mv.lead = { ...best, streak: true };
    }
  }

  // Aynı gün sektör ortalaması (hissenin kendisi hariç, ≥3 hisse).
  const daySec = {};
  for (const [sym, ser] of Object.entries(series)) {
    const sec = sectorOf(sym);
    if (!sec) continue;
    for (let i = Math.max(1, ser.d.length - WINDOW); i < ser.d.length; i++) {
      const r = pct(ser.c[i - 1], ser.c[i]);
      if (r == null || Math.abs(r) > 30) continue;
      const k = ser.d[i] + "|" + sec;
      (daySec[k] ||= { sum: 0, n: 0, list: [] });
      daySec[k].sum += r; daySec[k].n++;
      daySec[k].list.push([sym, r]);
    }
  }
  const secAvg = (sym, d, chg) => {
    const g = daySec[d + "|" + sectorOf(sym)];
    if (!g || g.n - 1 < 3) return null;
    return { avg: r1((g.sum - chg) / (g.n - 1)), n: g.n - 1 };
  };

  // Seri hikâyesi: üst üste sert hareketin başlangıcı, toplam değişimi ve
  // seri boyunca açıklanan gelişmeler (tarih sırasıyla).
  for (const [sym, list] of Object.entries(moves)) {
    const ser = series[sym];
    const asc = list.slice().sort((a, b) => (a.d < b.d ? -1 : 1));
    let start = null, steps = [];
    for (const mv of asc) {
      if (mv.run === 1) { start = mv; steps = []; }
      const st = mv.cause ? { c: mv.cause, d: mv.d, t: mv.refs[0]?.t || null, u: mv.refs[0]?.u || null }
        : mv.lead && !mv.lead.streak ? { c: mv.lead.c, d: mv.lead.d, t: mv.lead.t || null, u: mv.lead.u || null } : null;
      if (st && !steps.some((x) => x.c === st.c)) steps.push(st);
      if (mv.run > 1 && start) {
        const i0 = ser.d.indexOf(start.d), i1 = ser.d.indexOf(mv.d);
        mv.streak = { start: start.d, total: i0 > 0 && i1 >= 0 ? r1(pct(ser.c[i0 - 1], ser.c[i1])) : null, steps: steps.slice(0, 4) };
      }
    }
  }

  // 2. geçiş: bağlar — grup kümesi, atıflar, zincir etkisi; geçmiş karşılaştırma; arşiv.
  const casesOut = { ...prevCases };
  const moveOn = (s, d) => (moves[s] || []).find((m) => m.d === d);
  for (const [sym, list] of Object.entries(moves)) {
    const docs = getDocs(sym);
    for (const mv of list) {
      const theme = themes.find((t) => t.d === mv.d && t.syms.includes(sym));
      // Bu hissenin bildirimlerinde adı geçen şirketler (+ aynı günkü hareketleri).
      const named = new Set();
      for (const x of docs.filter((x) => x.d >= addDays(mv.d, -14) && x.d <= mv.d)) for (const s of mentionsOf(x, sym)) named.add(s);
      const linked = [...named].filter((s) => live[s] && live[s].close > 0).slice(0, 5).map((s) => ({ s, chg: moveOn(s, mv.d)?.chg ?? null }));
      // Bu hissenin adının geçtiği BAŞKA şirket bildirimleri (son 14 gün).
      const by = (mentionedBy[sym] || []).filter((m) => live[m.by] && live[m.by].close > 0)
        .filter((m) => m.x.d >= addDays(mv.d, -14) && m.x.d <= mv.d)
        .filter((m, i, a) => a.findIndex((o) => o.x.t === m.x.t) === i);
      const cited = by.slice(0, 3).map((m) => ({ s: m.by, k: m.x.kind, d: m.x.d, t: m.x.t, u: m.x.u, c: m.x.cats.length ? topCat(m.x.cats) : null }));

      // Zincir: kendi güçlü sebebi yoksa, aynı gün aynı yönde hareket eden grup üyesinin
      // ya da bu hisseyi anan şirketin güçlü sebebi.
      let chain = null;
      if (!strong(mv.cause)) {
        const cands = [];
        for (const s of theme ? theme.syms : []) if (s !== sym) { const om = moveOn(s, mv.d); if (om && strong(om.cause)) cands.push({ s, c: om.cause, ref: om.refs[0], via: "grup" }); }
        for (const m of by) {
          const om = moveOn(m.by, mv.d);
          if (om && strong(om.cause) && Math.sign(om.chg) === Math.sign(mv.chg)) cands.push({ s: m.by, c: om.cause, ref: om.refs[0], via: "atıf" });
          const mc = m.x.cats.length ? topCat(m.x.cats) : null;
          if (strong(mc)) cands.push({ s: m.by, c: mc, ref: { k: m.x.kind, t: m.x.t, u: m.x.u, d: m.x.d }, via: "atıf" });
        }
        cands.sort((a, b) => CAT_BY_KEY[b.c].w - CAT_BY_KEY[a.c].w);
        if (cands[0]) chain = { s: cands[0].s, c: cands[0].c, via: cands[0].via, k: cands[0].ref?.k || "kap", t: cands[0].ref?.t || null, u: cands[0].ref?.u || null, d: cands[0].ref?.d || null };
      }

      const ser = series[sym];
      const minAbs = Math.round(Math.max(4, Math.min(9.5, Math.abs(mv.chg) * 0.7)) * 10) / 10;
      Object.assign(mv, {
        chain,
        theme: theme ? { g: theme.group, syms: theme.syms.filter((s) => s !== sym).slice(0, 8) } : null,
        linked, cited,
        sa: secAvg(sym, mv.d, mv.chg),
        an: ownAnalog(ser, Math.sign(mv.chg), minAbs),
      });
      delete mv.i;

      // Vaka arşivi (öğrenme): olay + sonraki getiriler.
      const idx = ser.d.indexOf(mv.d);
      const fwd = (n) => (idx >= 0 && idx + n < ser.c.length ? r1(pct(ser.c[idx], ser.c[idx + n])) : null);
      casesOut[sym + "|" + mv.d] = {
        s: sym, d: mv.d, chg: mv.chg, lim: mv.limit ? 1 : 0, run: mv.run,
        c: mv.cause || (mv.chain ? "chain:" + mv.chain.c : mv.lead ? "lead:" + mv.lead.c : null),
        f1: fwd(1), f5: fwd(5), f20: fwd(20),
      };
    }
    list.sort((a, b) => (a.d < b.d ? 1 : -1));
  }

  // Arşiv sınırı: 400 günden eski vakalar atılır (dosya sınırsız büyümesin).
  const keepFrom = addDays(lastDay || session, -400);
  for (const [k, cs] of Object.entries(casesOut)) if (cs.d < keepFrom) delete casesOut[k];

  // Arşivdeki eski vakaların ileri getirilerini doldur (pencereden çıkmış olsalar da).
  for (const cs of Object.values(casesOut)) {
    if (cs.f20 != null) continue;
    const ser = series[cs.s];
    if (!ser) continue;
    const idx = ser.d.indexOf(cs.d);
    if (idx < 0) continue;
    const fwd = (n) => (idx + n < ser.c.length ? r1(pct(ser.c[idx], ser.c[idx + n])) : null);
    cs.f1 = cs.f1 ?? fwd(1); cs.f5 = cs.f5 ?? fwd(5); cs.f20 = fwd(20);
  }

  // Arşivden öğrenilenler: sebep türü × yön → sonraki 1/5/20 seans.
  const learned = {};
  // Yalnızca serinin İLK günü bir vakadır: 5 günlük taban serisinin her günü ayrı
  // sayılırsa aynı olay 5 kez oy kullanır (ölçüldü: "kontrol −" medyanı %-40,8 çıkıyordu).
  for (const cs of Object.values(casesOut)) {
    if (!cs.c || (cs.run || 1) > 1) continue;
    const base = cs.c.replace(/^(chain|lead):/, "");
    const k = base + (cs.chg > 0 ? "+" : "-");
    const L = (learned[k] ||= { n: 0, f1: [], f5: [], f20: [] });
    L.n++;
    if (cs.f1 != null) L.f1.push(cs.f1);
    if (cs.f5 != null) L.f5.push(cs.f5);
    if (cs.f20 != null) L.f20.push(cs.f20);
  }
  for (const [k, L] of Object.entries(learned)) {
    learned[k] = {
      n: L.n, n1: L.f1.length, n5: L.f5.length, n20: L.f20.length,
      f1: r1(median(L.f1)), f5: r1(median(L.f5)), f20: r1(median(L.f20)),
      up5: L.f5.length ? Math.round((L.f5.filter((x) => x > 0).length / L.f5.length) * 100) : null,
    };
  }

  // Haber → hareket bağları (Haberler sekmesinde rozet): bir hareketin sebebi,
  // zinciri, seri adımı ya da aynı aralıktaki kaydı olarak eşlenen her kaynak.
  const newsLinks = {};
  for (const [sym, list] of Object.entries(moves)) for (const mv of list) {
    const urls = new Set();
    for (const r of mv.refs || []) if (r.u) urls.add(r.u);
    if (mv.lead?.u) urls.add(mv.lead.u);
    if (mv.chain?.u) urls.add(mv.chain.u);
    for (const st of mv.streak?.steps || []) if (st.u) urls.add(st.u);
    for (const u of urls) {
      const arr = (newsLinks[u] ||= []);
      // Aynı hisse için yalnızca en yeni hareket (seri günlerini tekrar etme).
      const prev = arr.find((x) => x.s === sym);
      if (!prev) arr.push({ s: sym, d: mv.d, chg: mv.chg, run: mv.run });
      else if (mv.d > prev.d) Object.assign(prev, { d: mv.d, chg: mv.chg, run: mv.run });
    }
  }

  // Profil yalnızca hareketi olan ya da çekirdek hisseler için (dosya boyutu).
  const prof = {};
  for (const s of Object.keys(profiles)) if (moves[s] || core.has(s)) prof[s] = profiles[s];

  return {
    out: {
      v: 1, updatedAt: new Date().toISOString(), session,
      xu: xuChg[session] ?? null,
      moves, profiles: prof, themes: themes.filter((t) => recent.slice(-5).includes(t.d)),
      learned, newsLinks,
    },
    cases: casesOut,
  };
}

// ---- Claude ile anlatım (isteğe bağlı) ---------------------------------------------
const AI_SYSTEM = `Sen "Kaplan"sın: Borsa İstanbul paneli için açıklayıcı bir piyasa analistisin.
Görevin: bir hissenin belirli bir gündeki sert hareketini, YALNIZCA sana verilen kaynaklara (KAP bildirimleri, haberler) ve sayılara dayanarak, sade Türkçe ile 3-5 cümlede açıklamak.

Kurallar:
- Kaynaklarda olmayan hiçbir olgu, isim, rakam ya da ilişki yazma. Bir bağ kurarken (ör. grup şirketi, ortaklık) bunun hangi kaynaktan çıktığı belli olmalı; kaynak numarasını köşeli parantezle ver: [1], [2].
- Kaynaklar hareketi açıklamıyorsa bunu açıkça söyle ("Bu harekete dair şirketten ya da basından bir açıklama yok") ve yalnızca verilen bağlamı (grup/sektör/endeks) aktar.
- Olayın ne anlama geldiğini öğretici bir dille anlat (ör. TMSF'nin ortaklık haklarını kullanması ne demek, bedelsiz neden fiyatı düşürür).
- Geçmiş istatistik verildiyse onu geçmiş olarak aktar; geleceği tahmin etme.
- KESİNLİKLE al / sat / tut önerisi, hedef fiyat, "fırsat", "kaçırma", "dipten al" gibi yönlendirme ya da getiri tahmini yazma.
- Abartma, duygu katma, kesinlik iddia etme: "büyük olasılıkla", "kaynaklara göre" gibi ifadeler kullan.`;

const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "explained", "sources"],
  properties: {
    text: { type: "string", description: "3-5 cümlelik Türkçe açıklama, kaynak numaraları [n] ile" },
    explained: { type: "boolean", description: "Kaynaklar hareketin sebebini açıklıyor mu" },
    sources: { type: "array", items: { type: "integer" }, description: "Kullanılan kaynak numaraları" },
  },
};

// Tavsiye/yönlendirme dili: böyle bir metin yayımlanmaz (kurallı anlatım kalır).
// JS \b Türkçe harfleri kelime saymaz → Unicode harf sınırı kullanılır.
const ADVICE = /(?<!\p{L})(al(ın)?malı|sat(ıl)?malı|alınabilir|alım fırsatı|satış fırsatı|fırsat(ı)?|hedef fiyat|tavsiye ederim|öneririm|kaçırma(yın)?|dipten|toplanabilir|al sinyali|sat sinyali)(?!\p{L})/iu;

export async function aiExplain(result, input, cache, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { used: 0, skipped: "anahtar yok" };
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const model = process.env.KAPLAN_MODEL || "claude-opus-5-5";
  const perRun = Number(process.env.KAPLAN_AI_PER_RUN) || 8;
  const perDay = Number(process.env.KAPLAN_AI_DAILY) || 25;
  const today = result.session;
  const usedToday = Object.values(cache).filter((c) => c.at && c.at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  let budget = Math.max(0, Math.min(perRun, perDay - usedToday));
  const core = new Set((input.stocks.stocks || []).map((s) => s.symbol));
  const kapText = input.kapText;

  // Öncelik: bugünün olayları; çekirdek (BIST 100) önce, sonra sebebi güçlü taban/tavanlar.
  const cand = [];
  for (const [sym, list] of Object.entries(result.moves)) for (const mv of list) {
    if (mv.d < (opts.since || today)) continue;
    const sig = (mv.refs || []).map((r) => r.u || r.t).join("|") + "|" + (mv.limit || "") + "|" + (mv.chain?.u || "");
    const k = sym + "|" + mv.d;
    if (cache[k] && cache[k].sig === sig) { mv.ai = cache[k].text; mv.aiOk = cache[k].ok; continue; }
    const pri = (core.has(sym) ? 100 : 0) + (mv.limit ? 20 : 0) + (mv.cause ? (CAT_BY_KEY[mv.cause]?.w || 0) * 3 : 0) + Math.abs(mv.chg);
    cand.push({ sym, mv, k, sig, pri });
  }
  cand.sort((a, b) => b.pri - a.pri);
  let used = 0, cost = { in: 0, out: 0 };
  for (const { sym, mv, k, sig } of cand) {
    if (budget <= 0) break;
    const srcs = [];
    const addSrc = (r) => {
      if (!r || srcs.some((s) => s.u === r.u && s.t === r.t)) return;
      const id = (r.u || "").match(/kap\.org\.tr.*?(\d+)$/)?.[1];
      const body = id && kapText[id] ? (kapText[id].t || "").slice(0, 1500) : "";
      srcs.push({ ...r, body });
    };
    for (const r of mv.refs || []) addSrc({ ...r, kind: r.k });
    if (mv.lead?.t) addSrc({ kind: "kap", t: mv.lead.t, u: mv.lead.u, d: mv.lead.d });
    for (const st of mv.streak?.steps || []) if (st.t) addSrc({ kind: /kap\.org\.tr/.test(st.u || "") ? "kap" : "press", t: st.t, u: st.u, d: st.d });
    if (mv.chain?.t) addSrc({ kind: mv.chain.k || "kap", t: mv.chain.t, u: mv.chain.u, d: mv.chain.d, about: mv.chain.s });
    for (const c of mv.cited || []) addSrc({ kind: c.k || "kap", t: c.t, u: c.u, d: c.d, about: c.s });
    // Kaynak yoksa yapay zekânın söyleyeceği bir şey yok — kurallı anlatım yeter, para harcama.
    if (!srcs.length) continue;
    const lines = [
      `Hisse: ${sym} (${input.nameOf[sym] || sym})${mv.sec ? " · sektör: " + mv.sec : ""}`,
      `Gün: ${mv.d} · değişim: %${mv.chg}${mv.limit ? " (" + mv.limit + ")" : ""} · BIST 100 aynı gün: ${mv.xu == null ? "bilinmiyor" : "%" + mv.xu}`,
      mv.theme ? `Aynı gün aynı yönde sert hareket eden aynı gruptan (${mv.theme.g}) hisseler: ${mv.theme.syms.join(", ")}` : "",
      mv.linked?.length ? `Son 14 günün bildirimlerinde adı geçen listeli şirketler: ${mv.linked.map((l) => l.s + (l.chg != null ? " (aynı gün %" + l.chg + ")" : "")).join(", ")}` : "",
      mv.run > 1 && mv.streak ? `Seri: bu, ${mv.streak.start} tarihinde başlayan üst üste sert ${mv.chg > 0 ? "yükselişin" : "düşüşün"} ${mv.run}. günü; seri başından bu yana toplam %${mv.streak.total}.` : "",
      mv.an ? `Bu hissenin kendi geçmişi: son ~1 yılda %${mv.an.min.toFixed(1)}'den sert ${mv.chg > 0 ? "yükseliş" : "düşüş"} ${mv.an.n} kez; ertesi gün medyan %${mv.an.f1}, 5 seans sonra medyan %${mv.an.f5}${mv.an.f20 != null ? ", 20 seans sonra medyan %" + mv.an.f20 : ""}.` : "",
      "",
      "Kaynaklar:",
      ...srcs.map((s, i) => `[${i + 1}] ${s.kind === "kap" ? "KAP" : "Basın" + (s.s ? " (" + s.s + ")" : "")}${s.about ? " · " + s.about + " ile ilgili kayıt" : ""} · ${s.d} · ${s.t}${s.body ? "\n    Metin: " + s.body.replace(/\s+/g, " ") : ""}`),
    ].filter((l) => l !== null);
    try {
      const resp = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Haiku 4.5 "effort" ayarını desteklemez (400) — yalnız diğer modellerde gönder.
        output_config: { ...(/haiku/.test(model) ? {} : { effort: "low" }), format: { type: "json_schema", schema: AI_SCHEMA } },
        system: AI_SYSTEM,
        messages: [{ role: "user", content: lines.join("\n") }],
      });
      used++; budget--;
      cost.in += resp.usage?.input_tokens || 0; cost.out += resp.usage?.output_tokens || 0;
      if (resp.stop_reason === "refusal") continue;
      const txt = resp.content.find((b) => b.type === "text")?.text;
      if (!txt) continue;
      const j = JSON.parse(txt);
      if (!j.text || ADVICE.test(j.text)) { console.log("  Kaplan AI metni elendi (" + sym + ")"); continue; }
      mv.ai = j.text; mv.aiOk = !!j.explained;
      mv.aiSrc = srcs.map((s) => ({ k: s.kind, t: s.t, u: s.u, d: s.d, s: s.s || null }));
      cache[k] = { sig, text: j.text, ok: !!j.explained, src: mv.aiSrc, at: new Date().toISOString() };
    } catch (e) {
      console.log("  Kaplan AI hatası (" + sym + "): " + (e?.status || "") + " " + (e?.message || e).toString().slice(0, 160));
      if (e?.status === 401 || e?.status === 403 || e?.status === 400) break; // anahtar/bakiye sorunu: bu koşuda dur
    }
  }
  // Önbellekteki eski metinleri olaylara geri bağla (kaynak listesi dahil).
  for (const [sym, list] of Object.entries(result.moves)) for (const mv of list) {
    const c = cache[sym + "|" + mv.d];
    if (c && !mv.ai) { mv.ai = c.text; mv.aiOk = c.ok; }
    if (c && c.src) mv.aiSrc = c.src;
  }
  return { used, cost };
}

// ---- dosya giriş/çıkışı -------------------------------------------------------------
export async function runKaplan(dataDir, { ai = true } = {}) {
  const rd = async (n, fb) => { try { return JSON.parse(await fs.readFile(path.join(dataDir, n), "utf8")); } catch { return fb; } };
  const input = {
    stocks: await rd("stocks.json", { stocks: [] }),
    universe: await rd("universe.json", []),
    history: await rd("history.json", {}),
    historyExt: await rd("historyExt.json", {}),
    news: await rd("news.json", {}),
    kapText: await rd("kapText.json", {}),
    marketNews: (await rd("marketNews.json", { items: {} })).items || {},
    indices: await rd("indices.json", {}),
    fundamentals: await rd("fundamentals.json", {}),
    fundamentalsExt: await rd("fundamentalsExt.json", {}),
  };
  input.nameOf = Object.fromEntries(input.universe.map((u) => [u.symbol, u.name]));
  const prevCases = (await rd("kaplanCases.json", { cases: {} })).cases || {};
  const { out, cases } = computeKaplan(input, prevCases);
  let aiInfo = { used: 0 };
  const cache = (await rd("kaplanAi.json", {})) || {};
  if (ai) {
    try { aiInfo = await aiExplain(out, input, cache); } catch (e) { console.log("  Kaplan AI atlandı: " + (e?.message || e)); }
    // 45 günden eski önbellek kayıtlarını at.
    const cut = new Date(Date.now() - 45 * 864e5).toISOString();
    for (const [k, v] of Object.entries(cache)) if (!v.at || v.at < cut) delete cache[k];
    await fs.writeFile(path.join(dataDir, "kaplanAi.json"), JSON.stringify(cache));
  }
  out.ai = !!process.env.ANTHROPIC_API_KEY;
  await fs.writeFile(path.join(dataDir, "kaplan.json"), JSON.stringify(out));
  await fs.writeFile(path.join(dataDir, "kaplanCases.json"), JSON.stringify({ v: 1, updatedAt: out.updatedAt, cases }));
  const nMoves = Object.values(out.moves).reduce((a, l) => a + l.length, 0);
  const nCause = Object.values(out.moves).reduce((a, l) => a + l.filter((m) => m.cause).length, 0);
  console.log(`Kaplan: ${nMoves} sert hareket (${nCause} sebepli) · ${out.themes.length} grup kümesi · arşiv ${Object.keys(cases).length} vaka` +
    (aiInfo.used ? ` · AI ${aiInfo.used} açıklama (${aiInfo.cost.in}+${aiInfo.cost.out} token)` : aiInfo.skipped ? ` · AI: ${aiInfo.skipped}` : ""));
  return out;
}
