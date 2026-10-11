// TCMB EVDS (Elektronik Veri Dağıtım Sistemi) client — real macro series.
// Free API key required: https://evds3.tcmb.gov.tr → profil → API anahtarı.
// Key is passed as an HTTP header (`key`), NOT a URL param (TCMB security update).
//
// Guardrail: if a series code is wrong or EVDS returns nothing, we SKIP it and
// keep the existing seed value — we never fabricate a macro figure.

const BASE = "https://evds2.tcmb.gov.tr/service/evds/";

// EVDS field names replace every non-alphanumeric char with "_": TP.FG.J0 → TP_FG_J0
const fieldOf = (code) => code.replace(/[^A-Za-z0-9]/g, "_");

// EVDS monthly "Tarih" comes as "M-YYYY" or "YYYY-M"; normalise to "YYYY-MM-01".
function toISO(tarih) {
  const s = String(tarih || '').trim();
  let iso;
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) iso = `${m[1]}-${m[2].padStart(2,'0')}-01`;
  else if ((m = /^(\d{1,2})-(\d{4})$/.exec(s))) iso = `${m[2]}-${m[1].padStart(2,'0')}-01`;
  else if ((m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s))) iso = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return iso && Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0,10) === iso ? iso : null;
}

export function parseEvdsItems(items, code) {
  const f = fieldOf(code), values = new Map(), conflicts = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const date = toISO(it?.Tarih), raw = it?.[f];
    const value = raw == null || raw === '' ? NaN : Number(raw);
    if (!date || !Number.isFinite(value)) continue;
    if (values.has(date) && values.get(date) !== value) conflicts.add(date);
    values.set(date,value);
  }
  return [...values].filter(([date]) => !conflicts.has(date)).sort(([a],[b])=>a.localeCompare(b)).map(([date,value])=>({date,value}));
}

// Fetch one series from EVDS. Returns [{date:"YYYY-MM-01", value:Number}], oldest→newest.
// startDDMMYYYY / endDDMMYYYY are "DD-MM-YYYY". Returns [] on any failure.
export async function evdsSeries(key, code, startDDMMYYYY, endDDMMYYYY) {
  if (!key) return [];
  const end = endDDMMYYYY || new Date().toLocaleDateString("en-GB").replace(/\//g, "-"); // dd-mm-yyyy
  const url = `${BASE}series=${encodeURIComponent(code)}&startDate=${startDDMMYYYY}&endDate=${end}&type=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { key, "Accept": "application/json" } });
    if (!res.ok) { console.log(`  EVDS ${code}: HTTP ${res.status}`); return []; }
    const json = await res.json();
    return parseEvdsItems(json?.items, code);
  } catch (e) {
    console.log(`  EVDS ${code} hata: ${e.message}`);
    return [];
  }
}

// Series codes. Only the CONFIRMED ones are enabled by default; add others once
// verified against your EVDS account (a wrong code just yields [] and is skipped).
export const EVDS_CODES = {
  cpi: "TP.FG.J0",            // TÜFE genel endeks (2003=100), aylık — CONFIRMED
  usd: "TP.DK.USD.A.YTL",     // USD/TRY alış, günlük — CONFIRMED
};

// Disabled until the exact code, unit and frequency are verified against the official catalog.
// A plausible number alone does not validate a series.
export const EVDS_MACRO_CANDIDATES = [
  { key: "policyRate",     code: "TP.APIFON4",       event: "TCMB Faiz Kararı",        kind: "pct",   min: 0,      max: 100,    conf: "orta" },
  { key: "unemployment",   code: "TP.YISGUCU2.G8",   event: "İşsizlik Oranı",          kind: "pct",   min: 0,      max: 40,     conf: "orta" },
  { key: "currentAccount", code: "TP.ODEMGZK.BDTGE", event: "Cari İşlemler Dengesi",   kind: "bnusd", min: -50000, max: 50000,  conf: "düşük" },
];

// Compare exact calendar months. Missing observations never shift the period.
export function periodChangePct(series, months) {
  if (!Array.isArray(series) || !series.length) return null;
  const latest = series[series.length - 1];
  const m = /^(\d{4})-(\d{2})-01$/.exec(latest.date || '');
  if (!m || !Number.isFinite(latest.value) || latest.value <= 0) return null;
  const date = new Date(Date.UTC(Number(m[1]),Number(m[2])-1-months,1)).toISOString().slice(0,10);
  const matches = series.filter((p)=>p.date===date);
  if (matches.length!==1 || !Number.isFinite(matches[0].value) || matches[0].value<=0) return null;
  return (latest.value/matches[0].value-1)*100;
}
export const yoyPct = (series) => periodChangePct(series,12);
