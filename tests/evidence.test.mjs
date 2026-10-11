import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, aiExplain } from '../lib/kaplan.mjs';
import { documentCategories, safeAiText, limit } from '../lib/evidence.mjs';
import { companyRecords, chartActions } from '../lib/company-records.mjs';
import { parseKapFinancials } from '../lib/kap-financials.mjs';
import { yoyPct, parseEvdsItems, periodChangePct } from '../lib/evds.mjs';

test('negated fund liquidation is not issuer insolvency', () => {
  assert.deepEqual(classify('Tasfiyeye Konu Fonlara İlişkin Açıklama. 131 fonda bakiyemiz bulunmuyor.'), []);
  assert.deepEqual(classify('İflas iddiaları gerçeği yansıtmamaktadır.'), []);
  assert.ok(classify('Şirketin iflasına karar verilmiştir.').length);
});
test('press feed assignment alone does not prove identity', () => {
  const cats = [{key:'x', re:/bedelsiz/}];
  assert.deepEqual(documentCategories({kind:'press', t:'Başka şirket bedelsiz sermaye artırdı'}, 'TEST', 'Test Sanayi', cats), []);
  assert.deepEqual(documentCategories({kind:'press', t:'TEST bedelsiz sermaye artırdı'}, 'TEST', 'Test Sanayi', cats), ['x']);
});
test('AI advice and invalid source references are rejected', () => {
  const src = [{u:'https://www.kap.org.tr/tr/Bildirim/123'}];
  for (const text of ['Bu hisseleri satın alabilirsiniz [1].','Alım için iyi bir fırsat olabilir [1].','Şirketin bildirim yaptığı açıklandı [2].','Şirket bugün yeni bir bildirim yaptı.']) assert.equal(safeAiText(text, src), false);
  assert.equal(safeAiText('Şirket bugün bir bildirim yayımladı [1].',src), true);
  assert.equal(limit('0',8,8),0); assert.equal(limit('999',8,8),8); assert.equal(limit('-1',8,8),0);
});
test('failed AI requests still consume durable daily budget', async () => {
  const day = new Date().toISOString().slice(0,10), ledger = {[day]:24};
  let calls = 0, saves = 0;
  const client = {beta:{messages:{create: async () => {assert.equal(saves,1);calls++;throw new Error('fixture failure');}}}};
  const moves = {TEST:[{d:day, chg:8, refs:[{u:'https://www.kap.org.tr/tr/Bildirim/123',t:'Açıklama',d:day}]}]};
  const input = {stocks:{stocks:[]},kapText:{},nameOf:{}};
  await aiExplain({session:day,moves},input,{}, {client,ledger,saveLedger:async () => {saves++;}});
  await aiExplain({session:day,moves},input,{}, {client,ledger,saveLedger:async () => {saves++;}});
  assert.equal(calls,1);assert.equal(ledger[day],25);
});
test('no durable budget means no AI call',async()=>{
  const result = await aiExplain({}, {}, {}, {client:{}});
  assert.equal(result.used,0);
});
test('official records require exact KAP origin and deduplicate',()=>{
 const good={title:'Finansal Rapor',date:'2026-06-30',url:'https://www.kap.org.tr/tr/Bildirim/123'};
 const result=companyRecords({TEST:[good,good,{...good,url:'https://kap.org.tr.evil.test/tr/Bildirim/2'}]},{});
 assert.equal(result.TEST.length,1);assert.equal(result.TEST[0].financials,null);
});
test('split ratios and event dates remain explicit without adjusting prices',()=>{
 const result=chartActions({events:{splits:[{date:1780272000,numerator:2,denominator:1},{date:'bad',numerator:3,denominator:1}],dividends:[{date:'2026-06-01',amount:1.5}]}},'2026-06-02');
 assert.equal(result.items.length,2);assert.equal(result.items[0].date,'2026-06-01');
});
const header='<td class="financial-header-title">Sunum Para Birimi</td><td>TL</td><td class="financial-header-title">Finansal Tablo Niteliği</td><td>Konsolide</td>';
const table=(value,dates='01.01.2026 - 30.06.2026')=>`<table class="financial-table"><td class="context-header"><div class="content-tr">Cari Dönem<br>${dates}</div></td><tr class="data-input-row"><div class="taxonomy-field-name">ifrs-full_Revenue|Hasılat</div><td class="taxonomy-context-value"><span class="monetary-field-default" title="${value}"></span></td></tr></table>`;
test('financial amounts preserve reporting period and units',()=>{
 const fact=parseKapFinancials(header+table(7755320717)).facts[0];
 assert.equal(fact.value,7755320717);assert.equal(fact.start,'2026-01-01');assert.equal(fact.end,'2026-06-30');assert.equal(fact.currency,'TRY');
 assert.equal(parseKapFinancials(header.replace('>TL<','>Bin TL<')+table(10)),null);
 assert.equal(parseKapFinancials(header+table(10,'31.02.2026 - 30.06.2026')),null);
 assert.equal(parseKapFinancials(header+table(10)+table(20)),null);
});
test('yearly inflation uses same month previous year, not thirteen rows apart',()=>{
 const series=Array.from({length:13},(_,i)=>({date:`2025-${String(i+1).padStart(2,'0')}-01`,value:100}));
 series.push({date:'2026-01-01',value:130});assert.ok(Math.abs(yoyPct(series)-30)<1e-8);
 assert.equal(yoyPct(series.filter(s=>s.date!=='2025-01-01')),null);
});

test('EVDS rows are validated, sorted, and conflicting duplicates are excluded',()=>{
 const rows=parseEvdsItems([
  {Tarih:'3-2026',TP_FG_J0:'130'}, {Tarih:'1-2026',TP_FG_J0:'100'},
  {Tarih:'2-2026',TP_FG_J0:'110'}, {Tarih:'2-2026',TP_FG_J0:'115'},
  {Tarih:'31-02-2026',TP_FG_J0:'125'}, {Tarih:'4-2026',TP_FG_J0:''}
 ],'TP.FG.J0');
 assert.deepEqual(rows,[{date:'2026-01-01',value:100},{date:'2026-03-01',value:130}]);
 assert.equal(periodChangePct(rows,1),null);
});

test('financial calendar is not a financial report; parsed facts survive the news retention window',()=>{
 const previous={TEST:[{id:'123',kind:'financial',publishedAt:'2026-06-30',url:'https://www.kap.org.tr/tr/Bildirim/123',financials:{facts:[{value:10}]}}]};
 const out=companyRecords({TEST:[{title:'Finansal Takvim — Finansal Rapor İlan Tarihi',date:'2026-09-01',url:'https://www.kap.org.tr/tr/Bildirim/124'}]}, {}, previous);
 assert.equal(out.TEST.find(r=>r.id==='124').kind,'calendar');
 assert.equal(out.TEST.find(r=>r.id==='123').financials.facts[0].value,10);
});
