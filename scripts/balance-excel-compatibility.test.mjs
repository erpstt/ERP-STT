import {test} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {reportWorkbook} from '../public/spreadsheet-safety.js';

test('financial statement sheet properties follow OOXML order and retain presentation',async()=>{
 const blob=await reportWorkbook({headers:['Cuenta','Concepto','Saldo'],rows:[['1001','Caja',100],['','Total activos',100]],financialStatement:true,rowStyles:['tree-account','statement-net'],context:{subsidiaryName:'Empresa',periodLabel:'Al 25 de noviembre de 2026',currencyLabel:'USD'}});
 const bytes=await blob.arrayBuffer(),zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
 const properties=xml.match(/<sheetPr[^>]*>([\s\S]*?)<\/sheetPr>/)?.[1]||'';
 const names=[...properties.matchAll(/<(tabColor|outlinePr|pageSetUpPr)\b/g)].map(match=>match[1]),order={tabColor:0,outlinePr:1,pageSetUpPr:2};
 assert.deepEqual(names,[...names].sort((a,b)=>order[a]-order[b]),'Excel requires outlinePr before pageSetUpPr');
 assert.ok(xml.includes('fitToWidth="1"'));assert.ok(xml.includes('showGridLines="0"'));
 const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);assert.equal(book.worksheets[0].getCell('C8').value,100);assert.equal(book.worksheets[0].getCell('A1').value,'Empresa');
});
