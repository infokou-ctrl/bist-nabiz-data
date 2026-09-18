// Data-quality sanity checks for fundamentals.
// The panel shows what the source says (Yahoo), but flags implausible values so
// the UI can add an honest caveat instead of presenting garbage as fact.
// See CLAUDE.md known-issue #3 (e.g. THYAO pb:18.95). We NEVER silently rewrite
// a value — we only attach a `dq` flag list the app can surface.

// Thresholds tuned for BIST reality. Beyond these, the value is almost always a
// source glitch (wrong currency, split not applied, stale book value) rather than
// a real fundamental. Flags are advisory, not deletions.
const RULES = [
  { key: "pb",       test: (v) => v != null && (v <= 0 || v > 15),   flag: "pb_suspect" },
  { key: "pe",       test: (v) => v != null && v > 200,               flag: "pe_high" },
  { key: "roe",      test: (v) => v != null && Math.abs(v) > 3,       flag: "roe_suspect" }, // >300%
  { key: "divYield", test: (v) => v != null && v > 0.5,               flag: "divyield_suspect" }, // >50%
];

// Returns { flags: string[] } describing implausible fields, or null when clean.
export function checkFundamentals(f) {
  if (!f) return null;
  const flags = [];
  for (const r of RULES) if (r.test(f[r.key])) flags.push(r.flag);
  // 52-week band sanity: low must not exceed high.
  if (f.w52low != null && f.w52high != null && f.w52low > f.w52high) flags.push("w52_inverted");
  return flags.length ? { flags } : null;
}

// Human-readable Turkish label per flag — used by the app's caveat line.
export const DQ_LABELS = {
  pb_suspect: "PD/DD değeri kaynakta şüpheli görünüyor",
  pe_high: "F/K aşırı yüksek — kaynak verisi hatalı olabilir",
  roe_suspect: "Özkaynak kârlılığı (ROE) şüpheli görünüyor",
  divyield_suspect: "Temettü verimi anormal yüksek — kaynak hatası olabilir",
  w52_inverted: "52 hafta bandı tutarsız (alt > üst)",
};
