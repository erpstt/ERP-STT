import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [html,js,css]=await Promise.all([
  readFile('public/vat-declaration-report.html','utf8'),
  readFile('public/vat-declaration-report.js','utf8'),
  readFile('public/vat-declaration-report.css','utf8')
]);
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'La vista contiene IDs duplicados.');
for(const match of js.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1]),`Falta el elemento #${match[1]}.`);
for(const required of ['subsidiary','country','currency','periodMonth','priorPeriodCredit','includeAdjustments','statusPicker','summary','salesTable','purchasesTable','settlementContent','detailDialog','downloadPdf','downloadExcel'])assert.ok(ids.includes(required),`Falta el control ${required}.`);
assert.match(js,/\/api\/v1\/reports\/tax\/vat-declaration/);
assert.match(js,/documentStatuses/);
assert.match(js,/priorPeriodCredit/);
assert.match(js,/showModal\(\)/);
assert.match(js,/response\.blob\(\)/);
assert.match(js,/anchor\.download=name/);
assert.match(css,/\.settlement-equation/);
assert.match(css,/\.detail-dialog/);
assert.match(css,/@media\(max-width:850px\)/);
console.log(JSON.stringify({html:true,uniqueIds:true,scriptBindings:true,filters:true,drilldown:true,directDownloads:true,responsive:true}));
