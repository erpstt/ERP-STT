import assert from'node:assert/strict';
import{test}from'node:test';
import{mkdir,writeFile}from'node:fs/promises';
import{resolve,join}from'node:path';
import ExcelJS from'exceljs';
import{renderGeneralLedgerExport,generalLedgerPdfHtml}from'../dist/modules/reports/general-ledger-export-renderer.js';
import{preparePdfHtml}from'../dist/core/security/pdf-renderer.js';
import{parseBudgetCsv}from'../dist/modules/budget/budget.service.js';

function snapshot(count=523){
 const rows=[],accounts=new Map();for(let n=0;n<count;n++){
  const id=n%2+1,account=accounts.get(id)||{rows:[],debit:0n,credit:0n,balance:100000000n},debit=n%3===0?0n:123123456n,credit=n%3===0?23456789n:0n;
  account.debit+=debit;account.credit+=credit;account.balance+=debit-credit;
  const row={id:n+1,account_id:id,account_number:id===1?'000123':'000124',account_name:id===1?'Cuenta sintética, "ñ"':'Segunda cuenta sintética',nature:'Deudora',date:'2026-10-'+String(n%28+1).padStart(2,'0'),transaction_type:'Asiento de Diario General',transaction_number:'DOC-'+String(n+1).padStart(6,'0'),journal_number:'000'+String(n+1).padStart(6,'0'),entity_type:n%4<2?'Cliente':'Proveedor',entity_name:n===0?'=HYPERLINK("https://example.invalid")':'Tercero '+(n%4),cost_center:'Centro '+(n%3),concept:n===0?'Texto, "comillas"\nlínea segunda <script>alert(1)</script>':n===1?'Glosa larga completa '.repeat(45):'Movimiento sintético '+(n+1),debit:Number(debit)/1e6,credit:Number(credit)/1e6,running_balance:Number(account.balance)/1e6,opening_balance:100,original_currency_code:n%3===0?null:n%3===1?'USD':'JMD',original_exchange_rate:n%3===0?null:n%3===1?0.1234567891:1,original_debit:n%3===0?null:n===2?0:20.123456,original_credit:n%3===0?null:0};
  account.rows.push(row);accounts.set(id,account);rows.push(row);
 }
 let debit=0n,credit=0n;for(const a of accounts.values()){debit+=a.debit;credit+=a.credit;for(const r of a.rows)Object.assign(r,{account_debit_total:Number(a.debit)/1e6,account_credit_total:Number(a.credit)/1e6,account_final_balance:Number(a.balance)/1e6});}
 return{context:{subsidiary:{id:1,name:'Empresa sintética de exportación'},localCurrency:{id:1,code:'CRC',name:'Colón costarricense'},book:{id:1,name:'Libro principal sintético'},bookId:1,dateFrom:'2026-10-01',dateTo:'2026-10-31',filters:{subsidiaryIds:[1],bookId:1,dateFrom:'2026-10-01',dateTo:'2026-10-31'},generatedAt:'2026-11-09T20:00:00Z'},rows,total:rows.length,summary:{debit:Number(debit)/1e6,credit:Number(credit)/1e6},snapshotFingerprint:'a'.repeat(32)};
}
const parse=file=>parseBudgetCsv(file.buffer.toString('utf8').replace(/^\uFEFF/,''));
const movementRows=rows=>rows.filter(row=>row[0]==='MOVIMIENTO');
async function excel(file){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(file.buffer);return workbook;}
async function qa(file){if(!process.env.GENERAL_LEDGER_EXPORT_QA_DIR)return;const folder=resolve(process.env.GENERAL_LEDGER_EXPORT_QA_DIR);await mkdir(folder,{recursive:true});await writeFile(join(folder,file.fileName),file.buffer);}

test('CSV includes every movement beyond 500 rows, rectangular context and explicit account opening/closing records',async()=>{
 const source=snapshot(),copy=structuredClone(source),file=await renderGeneralLedgerExport(source,'csv','ACCOUNT'),rows=parse(file),header=rows[0];
 assert.equal(file.mimeType,'text/csv; charset=utf-8');assert.equal(file.fileName,'libro-mayor-2026-10-01-2026-10-31.csv');assert.ok(rows.every(row=>row.length===header.length));assert.equal(movementRows(rows).length,523);assert.ok(movementRows(rows).some(row=>row.includes('DOC-000523')));assert.equal(rows.filter(row=>row[0]==='SALDO_INICIAL').length,2);assert.equal(rows.filter(row=>row[0]==='TOTAL_CUENTA').length,2);assert.equal(rows.filter(row=>row[0]==='SUBTOTAL_GRUPO').length,0);assert.deepEqual(source,copy);
 const orig=header.indexOf('Moneda original');for(const row of rows.filter(row=>row[0]!=='MOVIMIENTO'&&row!==header))assert.deepEqual(row.slice(orig),['','','','']);assert.equal(rows[1][7],'000123');await qa(file);
});
test('CSV safely quotes commas, newlines and literal formula-like text while retaining numeric negatives and null/zero distinctions',async()=>{
 const file=await renderGeneralLedgerExport(snapshot(6),'csv','ENTITY'),rows=parse(file),headers=rows[0],find=(row,label)=>row[headers.indexOf(label)],movements=movementRows(rows);
 const first=movements.find(row=>row.includes('DOC-000001'));assert.equal(find(first,'Tercero / Entidad'),'\t=HYPERLINK("https://example.invalid")');assert.equal(find(first,'Concepto / Glosa'),'Texto, "comillas"\nlínea segunda <script>alert(1)</script>');assert.equal(find(first,'Tipo de cambio utilizado'),'');assert.equal(find(first,'Débito original'),'');
 const zero=movements.find(row=>row.includes('DOC-000003'));assert.equal(find(zero,'Moneda original'),'JMD');assert.equal(find(zero,'Débito original'),'0');assert.equal(find(zero,'Crédito original'),'0');assert.equal(find(zero,'No. asiento'),'000000003');
});
test('XLSX reopens with all rows, real dates/numbers, textual codes, legacy twelve-decimal rate format and no formulas or mixed original total',async()=>{
 const source=snapshot(),copy=structuredClone(source),file=await renderGeneralLedgerExport(source,'xlsx','COST'),book=await excel(file),sheet=book.getWorksheet('Libro Mayor'),movements=[];
 sheet.eachRow(row=>{if(row.getCell(1).value instanceof Date)movements.push(row);row.eachCell(cell=>assert.equal(cell.formula,undefined));});assert.equal(movements.length,523);assert.ok(movements.some(row=>row.getCell(3).value==='DOC-000523'));
 const first=movements.find(row=>row.getCell(3).value==='DOC-000001'),rate=movements.find(row=>row.getCell(3).value==='DOC-000002'),zero=movements.find(row=>row.getCell(3).value==='DOC-000003');
 assert.equal(first.getCell(1).value.toISOString(),'2026-10-01T00:00:00.000Z');assert.equal(first.getCell(4).value,'000000001');assert.equal(first.getCell(4).numFmt,'@');assert.equal(typeof first.getCell(9).value,'number');assert.equal(first.getCell(12).value,null);assert.equal(first.getCell(13).value,null);assert.equal(rate.getCell(12).value,0.1234567891);assert.equal(rate.getCell(12).numFmt,'0.############');assert.equal(zero.getCell(13).value,0);assert.equal(zero.getCell(14).value,0);assert.match(String(first.getCell(5).value),/^=HYPERLINK/);
 assert.ok([...Array(sheet.rowCount)].some((_,i)=>String(sheet.getCell(i+1,1).value).startsWith('000123 - ')));assert.equal(sheet.getRow(sheet.rowCount).getCell(10).value,null);for(const col of[11,12,13,14])assert.equal(sheet.getRow(sheet.rowCount).getCell(col).value,null);assert.deepEqual(source,copy);await qa(file);
});
test('ACCOUNT, ENTITY and COST retain official account closes and only add subgroup movement subtotals for selected views',async()=>{
 for(const view of['ACCOUNT','ENTITY','COST']){
  const source=snapshot(20),rows=parse(await renderGeneralLedgerExport(source,'csv',view)),header=rows[0],closings=rows.filter(row=>row[0]==='TOTAL_CUENTA');assert.equal(movementRows(rows).length,20);assert.equal(closings.length,2);assert.equal(rows.some(row=>row[0]==='SUBTOTAL_GRUPO'),view!=='ACCOUNT');
  for(const closing of closings){const first=source.rows.find(row=>row.account_number===closing[7]);assert.equal(Number(closing[header.indexOf('Saldo de la cuenta')]),first.account_final_balance);assert.equal(Number(closing[header.indexOf('Débito local')]),first.account_debit_total);}
  const html=generalLedgerPdfHtml(source,view);assert.match(html,/Saldo de la cuenta/);assert.doesNotMatch(html,/Saldo del tercero/);if(view!=='ACCOUNT')assert.match(html,/no representa el saldo del tercero/);
 }
});
test('the fixed PDF template escapes source data, repeats account headers, preserves original precision and prints page numbers',()=>{
 const source=snapshot(6),html=generalLedgerPdfHtml(source,'ENTITY'),safe=preparePdfHtml(html);assert.match(html,/@page\{size:A3 landscape/);assert.match(html,/counter\(page\)/);assert.match(html,/counter\(pages\)/);assert.match(html,/thead\{display:table-header-group/);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(safe,/<script\b|<iframe\b|<img\b/i);assert.match(html,/0,1234567891/);assert.equal((html.match(/Totales y saldo final de la cuenta/g)||[]).length,2);assert.match(html,/Moneda local: CRC/);
});
test('real secure PDF rendering produces a multipage downloadable file for the complete report',{timeout:90000},async t=>{
 const names=['PDF_RENDERER_URL','PDF_RENDERER_TOKEN'],prior=Object.fromEntries(names.map(name=>[name,process.env[name]]));for(const name of names)delete process.env[name];t.after(()=>{for(const name of names)if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name];});
 const file=await renderGeneralLedgerExport(snapshot(),'pdf','ACCOUNT');assert.equal(file.mimeType,'application/pdf');assert.equal(file.buffer.subarray(0,4).toString(),'%PDF');assert.ok(file.buffer.length>20000);assert.ok((file.buffer.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length>1);await qa(file);
});
test('empty complete snapshots produce legitimate empty downloads and missing/inconsistent source metadata fails before rendering',async()=>{
 const source=snapshot(0),file=await renderGeneralLedgerExport(source,'csv','ACCOUNT');assert.equal(parse(file).length,1);assert.match(generalLedgerPdfHtml(source,'ACCOUNT'),/Sin movimientos para los filtros seleccionados/);
 for(const mutate of[s=>s.total++,s=>s.rows[1].id=s.rows[0].id,s=>s.snapshotFingerprint='',s=>s.rows[0].original_debit='NaN',s=>s.rows[0].account_final_balance=null,s=>s.rows[0].date='2026-02-30']){const bad=snapshot(3);mutate(bad);await assert.rejects(renderGeneralLedgerExport(bad,'csv','ACCOUNT'),e=>e.status===502);}
 await assert.rejects(renderGeneralLedgerExport(snapshot(3),'html','ACCOUNT'),e=>e.status===400);await assert.rejects(renderGeneralLedgerExport(snapshot(3),'csv','FAKE'),e=>e.status===400);
});
