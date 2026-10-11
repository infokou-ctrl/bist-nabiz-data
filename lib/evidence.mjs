// Conservative evidence matching. Missing evidence is preferable to a false event.
const fold = (s) => String(s || '').normalize('NFKC').toLocaleLowerCase('tr-TR');
const NEGATED = /bulunma(?:mak|dı|maktadır|maktadır)|bulunmuyor|söz konusu değil|söz konusu olmam|ilişkisi yok|bakiyesi bulunm|maruziyeti bulunm|iddia|asılsız|gerçeği yansıtma|yalanla|vazgeç|iptal edil|geri çek|ödenmeyecek|dağıtılmay|dağıtmama/;
const THIRD_PARTY = /tasfiyeye konu fon|tasfiye edilen fon|tasfiye halindeki fon|spor kulüb|deplasman|basketbol|futbol|maç sonucu/;
export function evidenceCategories(text, categories) {
  const normalized = fold(text);
  // Negated disclosures can still contain an affirmative boilerplate title.
  if (NEGATED.test(normalized) || THIRD_PARTY.test(normalized)) return [];
  return categories.filter((c) => c.re.test(normalized)).map((c) => c.key);
}
export function documentCategories(doc, symbol, companyName, categories) {
  const title = fold(doc.t);
  if (doc.kind === 'press') {
    // A feed assignment is not proof that the story is about this company.
    const name = fold(companyName).replace(/\b(a\.ş\.|anonim şirketi)\b/g, '').trim();
    const ticker = new RegExp('(?<![\\p{L}\\d])' + symbol.replace(/[^A-Z0-9]/g, '') + '(?![\\p{L}\\d])', 'iu');
    if (!(ticker.test(doc.t) || (name.length >= 8 && title.includes(name)))) return [];
    // No category inferred from an incidental reference buried in an article.
    return evidenceCategories(title + ' ' + (NEGATED.test(fold(doc.body)) ? 'iddia' : ''), categories);
  }
  return evidenceCategories(doc.t + ' ' + (doc.body || ''), categories);
}
export function safeAiText(text, sources) {
  if (typeof text !== 'string' || text.length < 20 || text.length > 3000 || !Array.isArray(sources) || !sources.length) return false;
  const t = fold(text);
  if (/(?<!\p{L})(al|sat|tut|alın|satın|satın al|almalı|alınmalı|satmalı|satılmalı|tutmalı|tutulmalı|alınabilir|alım|satım|satış|fırsat|hedef fiyat|tavsiye|öneri|öneririm|kaçırma|dipten|toplanabilir|buy|sell|hold)(?!\p{L})/u.test(t)) return false;
  const refs = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  return refs.length > 0 && refs.every((n) => n >= 1 && n <= sources.length && /^https:\/\//.test(sources[n - 1]?.u || ''));
}
export const limit = (value, fallback, ceiling) => {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, ceiling) : 0;
};
