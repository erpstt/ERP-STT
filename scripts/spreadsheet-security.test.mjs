import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
import {csvCell,reportNumber,reportWorkbook} from '../public/spreadsheet-safety.js';
import {forecastCsv} from '../public/income-forecast-export.js';

test('CSV: comillas y delimitadores permanecen en una sola celda; textos peligrosos llevan prefijo',()=>{
 for(const text of ['=1+1','+SUM(A1:A2)','-1+2','@SUM(A1:A2)',' \t=1+1','\r=1+1','\n+1','\u0000=1','\ufeff=1','\u200b=1','\uff1d1+1','\uff0b1','\uff0d1','\uff201', '=1+1";=2+2\n,=3+3'])assert.equal(csvCell(text),'"\t'+text.replaceAll('"','""')+'"',JSON.stringify(text));
 for(const value of [-123.45,0,100])assert.equal(csvCell(value),'"'+value+'"');
 assert.equal(csvCell('-123.45'),'"\t-123.45"');assert.equal(csvCell('-123,45',{numeric:true}),'"-123,45"');
 assert.equal(csvCell('-1+2',{numeric:true}),'"\t-1+2"');assert.equal(csvCell('00123'),'"00123"');assert.equal(csvCell('Compa\u00f1\u00eda, "A"'),'"Compa\u00f1\u00eda, ""A"""');
});
test('importes de matriz: es-CR, paréntesis y símbolos sin convertir fórmulas ni texto arbitrario',()=>{
 for(const [text,expected]of [['US$ 1.234,56',1234.56],['(US$ 1.234,56)',-1234.56],['US$ 1\u00a0234,56',1234.56],['US$ 0,00',0],['US$ -12,34',-12.34]])assert.equal(reportNumber(text,'US$'),expected);
 for(const text of ['=1+1','US$ -1+1','00123','US$ 1,23E4','US$ NaN'])assert.equal(reportNumber(text,'US$'),text);
});
test('XLSX: texto literal, números, vínculos permitidos y solo SUM construido por el sistema',async()=>{
 const attack='=HYPERLINK("https://example.invalid","X")',headers=Array.from({length:28},(_,i)=>'Columna '+i),row=Array(28).fill('');row[0]=attack;row[1]=-123.45;row[2]='00123';row[3]={formula:'1+1'};row[26]=100;row[27]='Enlace';
 const blob=await reportWorkbook({headers,rows:[row],title:attack,context:{subsidiaryName:attack,periodLabel:'2026',currencyLabel:'USD'},totalColumns:[1,26],links:[{row:0,column:0,url:'javascript:alert(1)'},{row:0,column:27,url:'https://example.invalid/document'},{row:0,column:2,url:'https://user:password@example.invalid'}],extraSheets:[{headers:['Texto','Monto'],rows:[[attack,-9.5]]}]});
 assert.equal(blob.type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await blob.arrayBuffer());const sheet=workbook.worksheets[0];
 assert.equal(sheet.getCell('A1').value,attack);assert.equal(sheet.getCell('A2').value,attack);assert.equal(sheet.getCell('A7').value,attack);assert.equal(sheet.getCell('A7').type,ExcelJS.ValueType.String);
 assert.equal(sheet.getCell('B7').value,-123.45);assert.equal(sheet.getCell('C7').value,'00123');assert.equal(sheet.getCell('D7').value,'[object Object]');
 assert.equal(sheet.getCell('B8').formula,'SUM(B7:B7)');assert.equal(sheet.getCell('B8').result,-123.45);assert.equal(sheet.getCell('AA8').formula,'SUM(AA7:AA7)');
 assert.equal(sheet.getCell('AB7').hyperlink,'https://example.invalid/document');assert.equal(workbook.worksheets[1].getCell('A2').value,attack);assert.equal(workbook.worksheets[1].getCell('B2').value,-9.5);
 let formulas=0;for(const worksheet of workbook.worksheets)worksheet.eachRow(r=>r.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula)formulas++;}));assert.equal(formulas,2);
 await assert.rejects(reportWorkbook({headers:['A'],rows:[[1]],totalColumns:[-1]}),/inv\u00e1lida/);
});
test('forecast CSV: textos negativos protegidos y cifras mensuales/ajustes negativos numéricos',()=>{
 const report={companies:[{name:'=1+1'}],months:['2026-01'],k:1,currency:'USD',cutoff:'2026-01-31',method:'RUN_RATE',rows:[{key:'a',number:'001',name:'-1+2',category:'Ingreso',dimension:'total',values:[-123.45]}],notes:[' \n=1+1'],rates:[]};
 const csv=forecastCsv(report,{scenario:'@SUM(A1)',overrides:{'a:2026-01':{amount:-12.34,reason:'+1+1'}}});
 assert.ok(csv.startsWith('\ufeffsep=;\r\n'));assert.ok(csv.includes('"\t=1+1"'));assert.ok(csv.includes('"\t-1+2"'));assert.ok(csv.includes('"-123,45"'));assert.ok(csv.includes('"-12,34"'));assert.ok(csv.includes('"\t+1+1"'));
});
test('logo PNG permitido se incorpora sin permitir SVG ni URLs ejecutables',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=';
 for(const [logoUrl,count]of [[png,1],['data:image/svg+xml;base64,PHN2Zy8+',0],['javascript:alert(1)',0]]){const blob=await reportWorkbook({headers:['A'],rows:[['Texto']],context:{logoUrl}}),book=new ExcelJS.Workbook();await book.xlsx.load(await blob.arrayBuffer());assert.equal(book.model.media?.length||0,count);}
});
