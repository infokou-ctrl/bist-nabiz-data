// Source-linked official records derived from already downloaded KAP disclosures.
const kinds = [
  ['financial', /^finansal rapor(?:\s|$)/i],
  ['calendar', /finansal takvim/i],
  ['dividend', /k[aâ]r payı dağıtım/i],
  ['capital', /sermaye artırımı|sermaye azaltımı|sermaye artırımı - azaltımı|pay bölün/i],
  ['trading', /işlem sırası|işlem.*durdur|volatilite bazlı tedbir|brüt takas|vbts|tek fiyat/i],
];
export function companyRecords(news, texts, previous = {}) {
  const out = {};
  const official = (u) => /^https:\/\/(?:www\.)?kap\.org\.tr\/tr\/Bildirim\/\d+$/.test(u || '');
  for (const [symbol, rows] of Object.entries(previous || {})) {
    if (Array.isArray(rows)) out[symbol] = rows.filter((r) => r && official(r.url) && typeof r.publishedAt === 'string');
  }
  for (const [symbol, items] of Object.entries(news || {})) {
    const seen = new Set();
    for (const item of items || []) {
      const id = /^https:\/\/(?:www\.)?kap\.org\.tr\/tr\/Bildirim\/(\d+)$/.exec(item.url || '')?.[1];
      const kind = kinds.find(([, re]) => re.test(item.title || ''))?.[0];
      if (!id || !kind || seen.has(id) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date || '')) continue;
      seen.add(id);
      const text = texts?.[id];
      const prior = out[symbol]?.find((r) => r.id === id);
      if (out[symbol]) out[symbol] = out[symbol].filter((r) => r.id !== id);
      (out[symbol] ||= []).push({ id, kind, title: item.title, publishedAt: item.date, url: item.url,
        // Original labels preserve payment vs ex-date and share-class distinctions.
        fields: (text?.f || []).filter(([label]) => /tarih|pay grup|ödeme|hak kullanım|başlangıç|bitiş|oran|para birimi|sermaye/i.test(label)),
        financials: text && "financials" in text ? text.financials : prior?.financials || null,
        fetchedAt: text?.fetchedAt || prior?.fetchedAt || null,
      });
    }
    if (out[symbol]) out[symbol].sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || Number(b.id)-Number(a.id));
  }
  for (const [symbol, rows] of Object.entries(out)) {
    rows.sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || Number(b.id)-Number(a.id));
    // Keep four reports across quarterly gaps; bound the operational records.
    out[symbol] = [...rows.filter((r)=>r.kind==='financial').slice(0,4), ...rows.filter((r)=>r.kind!=='financial').slice(0,12)];
  }
  return out;
}
export function chartActions(chart, fetchedAt) {
  const date = (v) => { const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0,10) : null; };
  const list = [];
  for (const x of chart.events?.splits || []) {
    const d = date(x.date);
    if (d && Number.isFinite(x.numerator) && Number.isFinite(x.denominator) && x.numerator > 0 && x.denominator > 0)
      list.push({type:'split',date:d,numerator:x.numerator,denominator:x.denominator});
  }
  for (const x of chart.events?.dividends || []) {
    const d = date(x.date);
    if (d && Number.isFinite(x.amount) && x.amount >= 0) list.push({type:'dividend',date:d,amount:x.amount});
  }
  return {source:'Yahoo Finance',fetchedAt,items:list.sort((a,b)=>a.date.localeCompare(b.date))};
}
