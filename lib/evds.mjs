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
  if (!tarih) return null;
  const s = String(tarih).trim();
  let y, m;
  let mo = s.match(/^(\d{4})-(\d{1,2})$/);      // 2026-8
  if (mo) { y = mo[1]; m = mo[2]; }
  else if ((mo = s.match(/^(\d{1,2})-(\d{4})$/))) { m = mo[1]; y = mo[2]; } // 8-2026
  else if ((mo = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) return `${mo[3]}-${mo[2].padStart(2,"0")}-${mo[1].padStart(2,"0")}`; // daily dd-mm-yyyy
  else return null;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

// Fetch one series from EVDS. Returns [{date:"YYYY-MM-01", value:Number}], oldest→newest.
// startDDMMYYYY / endDDMMYYYY are "DD-MM-YYYY". Returns [] on any failure.
export async function evdsSeries(key, code, startDDMMYYYY, endDDMMYYYY) {
  if (!key) return [];
  const end = endDDMMYYYY || new Date().toLocaleDateString("en-GB").replace(/\//g, "-"); // dd-mm-yyyy
  const url = `${BASE}series=${encodeURIComponent(code)}&startDate=${startDDMMYYYY}&endDate=${end}&type=json`;
  try {
    const res = await fetch(url, { headers: { key, "Accept": "application/json" } });
    if (!res.ok) { console.log(`  EVDS ${code}: HTTP ${res.status}`); return []; }
    const json = await res.json();
    const items = Array.isArray(json?.items) ? json.items : [];
    const f = fieldOf(code);
    const out = [];
    for (const it of items) {
      const iso = toISO(it.Tarih);
      const raw = it[f];
      const v = raw == null || raw === "" ? null : Number(raw);
      if (iso && v != null && isFinite(v)) out.push({ date: iso, value: v });
    }
    return out;
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

// Candidate macro series whose EXACT codes couldn't be verified offline (they sit
// behind the EVDS SPA). Each carries a sanity range: on the first real run the
// value is fetched, logged, and ONLY accepted if plausible — so a wrong code
// (empty) or a valid-but-mislabelled code (insane value) is rejected, never shown.
// Confirm the logged values against reality (faiz≈%37, işsizlik≈%8-9, cari: milyar $),
// then promote a verified code into EVDS_CODES if you like.
export const EVDS_MACRO_CANDIDATES = [
  { key: "policyRate",     code: "TP.APIFON4",       event: "TCMB Faiz Kararı",        kind: "pct",   min: 0,      max: 100,    conf: "orta" },
  { key: "unemployment",   code: "TP.YISGUCU2.G8",   event: "İşsizlik Oranı",          kind: "pct",   min: 0,      max: 40,     conf: "orta" },
  { key: "currentAccount", code: "TP.ODEMGZK.BDTGE", event: "Cari İşlemler Dengesi",   kind: "bnusd", min: -50000, max: 50000,  conf: "düşük" },
];

// Year-over-year % change from a monthly index series (last vs 12 months earlier).
export function yoyPct(series) {
  if (!series || series.length < 13) return null;
  const last = series[series.length - 1].value;
  const prev = series[series.length - 13].value;
  if (!(prev > 0)) return null;
  return (last / prev - 1) * 100;
}
