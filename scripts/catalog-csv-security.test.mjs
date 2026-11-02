import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {csvCell} from '../dist/core/export/csv-cell.js';
import {csvCell as browserCell} from '../public/spreadsheet-safety.js';
import {parseBudgetCsv} from '../dist/modules/budget/budget.service.js';
import {buildCostCenterCsv} from '../dist/modules/organization-catalogs/cost-center-export.service.js';
import {buildOrganizationCatalogCsv} from '../dist/modules/organization-catalogs/organization-catalog-export.service.js';
import {buildEntityCatalogCsv} from '../dist/modules/entity-catalogs/entity-export.service.js';
import {buildAssetCategoryCsv} from '../dist/modules/fixed-asset-catalogs/asset-category-export.service.js';
import {buildFixedAssetCsv} from '../dist/modules/fixed-asset-catalogs/fixed-asset-export.service.js';
const attacks=['=1+1','+SUM(A1:A2)','-1+2','@SUM(A1:A2)',' \t=1+1','\r=1+1','\n=1+1','\u0000=1+1','\u200b=1+1','\u2066=1+1','\uff1d1+1','\uff0b1','\uff0d1','\uff201','=1+1";=2+2\n,=3+3'];
test('políticas de CSV de servidor y navegador coinciden sin convertir códigos ni números',()=>{
 for(const value of [...attacks,'00123','Texto, "citado"',null,true,-123.45,0])assert.equal(csvCell(value),browserCell(value));
 assert.equal(csvCell(-123.45),'"-123.45"');assert.equal(csvCell('-123.45'),'"\t-123.45"');assert.equal(csvCell('00123'),'"00123"');
});
const numeric=new Set(['id','creditLimit','cost','accumulated','bookValue','residualPercentage']);
const builders=[['centros',row=>buildCostCenterCsv([row])],['organización',row=>buildOrganizationCatalogCsv([{key:'name',label:'Nombre',type:'text'},{key:'cost',label:'Monto',type:'number'},{key:'code',label:'Código',type:'text'}],[row])],['entidades',row=>buildEntityCatalogCsv('customers',[row])],['categorías',row=>buildAssetCategoryCsv([row])],['activos',row=>buildFixedAssetCsv([row])]];
for(const [name,build]of builders)test('CSV real de '+name+': texto neutralizado y números/códigos conservados',()=>{
 for(const attack of attacks){const row=new Proxy({},{get:(_,key)=>numeric.has(key)?-123.45:key==='code'?'00123':attack}),csv=build(row).toString('utf8'),records=parseBudgetCsv(csv.replace(/^\ufeff/,''));assert.equal(records.length,2);assert.ok(records[1].includes('\t'+attack),name+': '+JSON.stringify(attack));assert.ok(records[1].includes('-123.45'));assert.ok(!csv.includes('"\t-123.45"'),'Numbers must not receive text prefix');if(name!=='activos')assert.ok(records[1].includes('00123'));assert.equal(records[0].length,records[1].length);}
});
test('plantillas estáticas: inventario de nueve CSV y seis XLSX sin fórmulas',async()=>{
 const names=(await readdir(new URL('../public/',import.meta.url))).filter(n=>n.startsWith('plantilla-'));
 const csv=names.filter(n=>n.endsWith('.csv')),xlsx=names.filter(n=>n.endsWith('.xlsx'));assert.equal(csv.length,9);assert.equal(xlsx.length,6);
 for(const name of csv){const records=parseBudgetCsv((await readFile(new URL('../public/'+name,import.meta.url),'utf8')).replace(/^\ufeff/,''));for(const row of records)for(const value of row)assert.ok(!/^[\s\p{Cf}\u0000-\u001f]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(value)||/^-\d+(?:\.\d+)?$/.test(value.trim()),name);}
 for(const name of xlsx){const book=new ExcelJS.Workbook();await book.xlsx.load(await readFile(new URL('../public/'+name,import.meta.url)));for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>assert.notEqual(cell.type,ExcelJS.ValueType.Formula,name)));}
});
