import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
import {parseBankStatementFile, resolveBankStatementBalances} from '../dist/modules/reports/bank-statement-import.js';

const csv = text => parseBankStatementFile({fileName:'extracto.csv',text});

test('conserva notas CSV con comas, comillas, saltos de línea y valores locales',async()=>{
  const parsed=await csv('\uFEFFfecha;fecha_valor;referencia;nota;beneficiario;monto;saldo_inicial\r\n03/11/2026;04/11/2026;DEP-1;"Depósito, factura ""A""\nSegunda línea";Cliente;"1.234,50";"2.000,00"\r\n');
  assert.deepEqual(parsed.lines,[{date:'2026-11-03',valueDate:'2026-11-04',reference:'DEP-1',description:'Depósito, factura "A"\nSegunda línea',beneficiary:'Cliente',amount:1234.5}]);
  assert.equal(parsed.openingBalance,2000);assert.equal(parsed.closingBalance,3234.5);assert.equal(parsed.balanceSource,'FILE_BALANCES');
});

test('lee saldos en filas de cabecera sin exigir digitación y conserva saldo cero',async()=>{
  const parsed=await csv('Saldo inicial,0\nSaldo final,-25.50\nfecha,monto\n2026-11-03,-25.50\n');
  assert.equal(parsed.openingBalance,0);assert.equal(parsed.closingBalance,-25.5);
});

test('deriva el saldo inicial desde saldo final sin asumir cero',async()=>{
  const parsed=await csv('date,amount,closing_balance\n2026-11-02,100,0\n2026-11-03,-50,\n');
  assert.equal(parsed.openingBalance,-50);assert.equal(parsed.closingBalance,0);
  assert.equal(resolveBankStatementBalances(parsed,999).openingBalance,-50);
});

test('infiere ambos saldos desde saldos acumulados en orden ascendente',async()=>{
  const parsed=await csv('fecha,monto,saldo\n2026-11-01,100,1100\n2026-11-02,-250,850\n2026-11-03,50,900\n');
  assert.equal(parsed.openingBalance,1000);assert.equal(parsed.closingBalance,900);assert.equal(parsed.balanceSource,'RUNNING_BALANCES');
});

test('infiere saldos acumulados en orden descendente con movimientos del mismo día',async()=>{
  const parsed=await csv('fecha,monto,saldo_acumulado\n2026-11-03,50,900\n2026-11-02,-250,850\n2026-11-02,100,1100\n');
  assert.equal(parsed.openingBalance,1000);assert.equal(parsed.closingBalance,900);
  assert.equal(parsed.lines[0].date,'2026-11-03');
});

test('saldo inicial explícito debe coincidir con el saldo acumulado',async()=>{
  await assert.rejects(csv('fecha,monto,saldo,saldo_inicial\n2026-11-01,100,1100,500\n'),/no coinciden/);
});

test('rechaza saldos acumulados contradictorios',async()=>{
  await assert.rejects(csv('fecha,monto,saldo\n2026-11-01,100,1100\n2026-11-02,-250,800\n'),/saldos acumulados/);
});

test('rechaza saldo final que no concuerda con movimientos y saldo inicial',async()=>{
  await assert.rejects(csv('fecha,monto,saldo_inicial,saldo_final\n2026-11-03,100,1000,1200\n'),/no coinciden con la suma/);
});

test('sin saldos devuelve null y solo usa un cierre anterior explícito, incluido cero',async()=>{
  const parsed=await csv('fecha,monto\n2026-11-03,-15\n');
  assert.equal(parsed.openingBalance,null);assert.equal(parsed.closingBalance,null);assert.equal(parsed.balanceSource,null);
  assert.throws(()=>resolveBankStatementBalances(parsed),/no incluye saldos/);
  const resolved=resolveBankStatementBalances(parsed,0);
  assert.equal(resolved.openingBalance,0);assert.equal(resolved.closingBalance,-15);assert.equal(resolved.balanceSource,'PREVIOUS_RECONCILIATION');
  assert.equal(parsed.openingBalance,null);
});

const ofx = balance => `<OFX><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>20261103120000[-6:CST]<TRNAMT>-25.5<FITID>ABC<MEMO>Pago recibido<NAME>Proveedor</STMTTRN></BANKTRANLIST>${balance}</STMTRS></OFX>`;
test('OFX y QFX usan LEDGERBAL con fecha y omiten saldo disponible AVAILBAL',async()=>{
  for(const fileName of ['extracto.ofx','extracto.qfx']){
    const parsed=await parseBankStatementFile({fileName,text:ofx('<AVAILBAL><BALAMT>9999</AVAILBAL><LEDGERBAL><BALAMT>-25.50<DTASOF>20261103235959</LEDGERBAL>')});
    assert.equal(parsed.openingBalance,0);assert.equal(parsed.closingBalance,-25.5);assert.equal(parsed.balanceDate,'2026-11-03');assert.equal(parsed.balanceSource,'OFX_LEDGER_BALANCE');
    assert.equal(parsed.lines[0].reference,'ABC');
  }
  const availableOnly=await parseBankStatementFile({fileName:'extracto.ofx',text:ofx('<AVAILBAL><BALAMT>9999</AVAILBAL>')});
  assert.equal(availableOnly.closingBalance,null);
});

test('rechaza varios extractos OFX en un mismo archivo',async()=>{
  await assert.rejects(parseBankStatementFile({fileName:'extracto.ofx',text:ofx('')+ofx('')}),/varios extractos/);
});

test('OFX incompleto o con saldo anterior a sus movimientos requiere un archivo consistente',async()=>{
  await assert.rejects(parseBankStatementFile({fileName:'extracto.ofx',text:ofx('').replace('</STMTTRN>','')}),/movimientos incompletos/);
  await assert.rejects(parseBankStatementFile({fileName:'extracto.ofx',text:ofx('<LEDGERBAL><BALAMT>100<DTASOF>20261101</LEDGERBAL>')}),/posteriores a la fecha/);
});

test('Excel comparte los saldos y validación de movimientos del CSV',async()=>{
  const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Extracto');
  sheet.addRow(['Saldo inicial',-10]);sheet.addRow(['fecha','fecha_valor','referencia','nota','monto','saldo']);
  sheet.addRow([new Date('2026-11-02T12:00:00Z'),new Date('2026-11-03T12:00:00Z'),'DEP-X','Nota Excel',20,10]);
  sheet.addRow([new Date('2026-11-03T12:00:00Z'),null,'PAG-X','Pago Excel',-5,5]);
  const buffer=await workbook.xlsx.writeBuffer();
  const parsed=await parseBankStatementFile({fileName:'extracto.xlsx',base64:Buffer.from(buffer).toString('base64')});
  assert.equal(parsed.openingBalance,-10);assert.equal(parsed.closingBalance,5);assert.equal(parsed.lines.length,2);
  assert.equal(parsed.lines[0].date,'2026-11-02');assert.equal(parsed.lines[0].valueDate,'2026-11-03');assert.equal(parsed.lines[1].description,'Pago Excel');
});

test('CSV también admite contenido base64 y no inventa saldos',async()=>{
  const parsed=await parseBankStatementFile({fileName:'extracto.csv',base64:Buffer.from('fecha,monto\n2026-11-03,1').toString('base64')});
  assert.equal(parsed.lines[0].amount,1);assert.equal(parsed.openingBalance,null);
});

test('rechaza fechas imposibles, montos no válidos y filas omitidas silenciosamente',async()=>{
  await assert.rejects(csv('fecha,monto\n2026-02-31,100'),/fecha/);
  await assert.rejects(csv('fecha,monto\n2026-11-03,no-numérico'),/monto/);
  await assert.rejects(csv('fecha,monto\n2026-11-03,0'),/diferente de cero/);
  await assert.rejects(csv('fecha,monto\n2026-11-03,100\ninvalida,50'),/fecha/);
});

test('rechaza formato, codificación y tamaño inválidos',async()=>{
  await assert.rejects(parseBankStatementFile({fileName:'extracto.exe',text:'x'}),/CSV, Excel/);
  await assert.rejects(parseBankStatementFile({fileName:'extracto.csv',base64:'%%%='}),/codificación/);
  await assert.rejects(parseBankStatementFile({fileName:'extracto.csv',text:'x'.repeat(5*1024*1024+1)}),/5 MB/);
  await assert.rejects(parseBankStatementFile({fileName:'extracto.xlsx',base64:Buffer.from('invalid excel').toString('base64')}),/Excel no se pudo leer/);
});
