// Parse only explicitly identified taxonomy facts + period + currency.
// No inference from prose, no assumption that six-month values are a quarter.
const METRICS = {
  'ifrs-full_Revenue': 'revenue',
  'ifrs-full_ProfitLossFromOperatingActivities': 'operatingProfit',
  'ifrs-full_ProfitLoss': 'netProfit',
  'ifrs-full_CashFlowsFromUsedInOperatingActivities': 'operatingCashFlow',
  'ifrs-full_CashAndCashEquivalents': 'cash',
  'ifrs-full_LongtermBorrowings': 'longTermBorrowings',
};
const plain = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
export function kapPayload(html) {
  let payload = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { payload += JSON.parse(m[1]); } catch { /* incomplete payload is ignored */ }
  }
  return payload;
}
function iso(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!m) return null;
  const d = `${m[3]}-${m[2]}-${m[1]}`;
  return Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d ? d : null;
}
export function parseKapFinancials(payload) {
  const unit = /financial-header-title[^>]*>\s*Sunum Para Birimi\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>/i.exec(payload)?.[1]?.trim();
  // Unknown scaling must never be silently treated as TRY units.
  if (!['TL','TRY','USD','EUR'].includes(unit)) return null;
  const currency = unit === 'TL' ? 'TRY' : unit;
  const consolidation = /financial-header-title[^>]*>\s*Finansal Tablo Niteliği\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>/i.exec(payload)?.[1]?.trim();
  if (!consolidation) return null;
  const facts = [];
  for (const section of payload.split(/<table\b[^>]*class="financial-table\b[^\"]*"[^>]*>/i).slice(1)) {
    const header = /<td\b[^>]*class="context-header"[^>]*>([\s\S]*?)<\/td>/i.exec(section)?.[1];
    const tr = header && /content-tr"[^>]*>([\s\S]*?)<\/div>/i.exec(header)?.[1];
    if (!tr || !/^Cari Dönem\s*<br\s*\/?\s*>/i.test(tr)) continue;
    const dates = [...tr.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map((m) => iso(m[0]));
    if (!dates.length || dates.some((d) => !d) || dates.length > 2) continue;
    for (const row of section.split(/<tr\b[^>]*class="[^"]*data-input-row[^"]*"[^>]*>/i).slice(1)) {
      const tag = /taxonomy-field-name">([^<|]+)[|<]/.exec(row)?.[1];
      const key = METRICS[tag];
      if (!key) continue;
      const cell = /<td\b[^>]*class="taxonomy-context-value\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(row)?.[1];
      const raw = cell && /monetary-field-default[^>]*\btitle="(-?\d+(?:\.\d+)?)"/.exec(cell)?.[1];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const start = dates.length === 2 ? dates[0] : null, end = dates.at(-1);
      // Instant facts only in balance sheet; flow facts require a duration.
      if (['cash','longTermBorrowings'].includes(key) ? !!start : !start) continue;
      const fact = { key, value, currency, scale: 1, start, end, taxonomy: tag };
      const existing = facts.find((x) => x.key === key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(fact)) return null;
      if (!existing) facts.push(fact);
    }
  }
  return facts.length ? { consolidation: plain(consolidation), currency, facts } : null;
}
