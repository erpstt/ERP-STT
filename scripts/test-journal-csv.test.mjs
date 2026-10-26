import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  journalCsvHeaders,
  normalizeJournalServiceDimensions,
  normalizeJournalServiceMonths,
  parseJournalCsv
} from '../dist/modules/accounting-catalogs/journal-import.service.js';
const header = journalCsvHeaders.slice(0,11).join(',');
const line = 'A,ASI_DIA,2026-09-08,CRC,1,Nota,001,10.00,0.00,Detalle,';
test('the downloadable template has two balanced journals and preserves account codes', () => {
  const rows = parseJournalCsv(readFileSync('public/plantilla-asientos-contables.csv','utf8'));
  const totals = new Map();
  for (const row of rows) totals.set(row.asiento_referencia, (totals.get(row.asiento_referencia) || 0) + Number(row.debito) - Number(row.credito));
  assert.equal(totals.size, 2); assert.deepEqual([...totals.values()], [0, 0]);
  assert.equal(parseJournalCsv(`${header}\n${line}`)[0].numero_cuenta, '001');
});
test('BOM, CRLF, quoted commas, escaped quotes and multiline notes', () => {
  const rows = parseJournalCsv(`\uFEFF${header}\r\nA,ASI_DIA,2026-09-08,CRC,1,"Nota, con ""comillas""\r\ny salto",001,10,0,Detalle,\r\n`);
  assert.equal(rows[0].nota_asiento, 'Nota, con "comillas"\ny salto');
});
test('semicolon files and reordered columns', () => {
  assert.equal(parseJournalCsv(`${header.replaceAll(',',';')}\n${line.replaceAll(',',';')}`)[0].debito,'10.00');
  assert.equal(parseJournalCsv(`${journalCsvHeaders.slice(0,11).toReversed().join(',')}\n${line.split(',').reverse().join(',')}`)[0].numero_cuenta,'001');
});
test('malformed or empty files are rejected instead of silently dropping records', () => {
  for (const csv of ['',header,`${header}\n${line},extra`,`${header}\n"open`,`${header}\n${line.replace('Nota','No"ta')}`,`${header}\n${line.replace('Nota','"Nota"extra')}`,`${header.replace('fecha','moneda')}\n${line}`]) assert.throws(() => parseJournalCsv(csv));
});
test('size and row limits', () => {
  assert.throws(() => parseJournalCsv('x'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
  assert.throws(() => parseJournalCsv(`${header}\n${Array(2001).fill(line).join('\n')}`), /2000/);
});
test('additional dimensions are retained and blank optional columns preserve old receipts',()=>{
  const fullHeader=journalCsvHeaders.join(',');
  const expanded=parseJournalCsv(`${fullHeader}\n${line},Costa Rica,Cliente,Cliente ejemplo,Servicios,Proyecto,Consultoria,Banco,Relacionada`)[0];
  assert.equal(expanded.pais_servicio,'Costa Rica');
  assert.equal(expanded.entidad,'Cliente'); assert.equal(expanded.nombre,'Cliente ejemplo');
  assert.equal(expanded.departamento,'Servicios'); assert.equal(expanded.centro_costos,'Proyecto');
  assert.equal(expanded.clase,'Consultoria'); assert.equal(expanded.acreedor_financiero,'Banco'); assert.equal(expanded.compania_relacionada,'Relacionada');
  assert.deepEqual(parseJournalCsv(`${fullHeader}\n${line},,,,,,,,`),parseJournalCsv(`${header}\n${line}`));
});
test('service dimensions are ignored only for journal types derived from the posting date',()=>{
  const source=[
    {tipo_asiento:'ASI_DIA',fecha:'2026-10-02',mes_servicio:'1999-01',pais_servicio:'Jamaica'},
    {tipo_asiento:'ASI_NOM',fecha:'2026-10-15',mes_servicio:'2030-12',pais_servicio:'CRI'},
    {tipo_asiento:'ASI_LIQ',fecha:'2026-10-31',mes_servicio:'invalid',pais_servicio:'ID:1'},
    {tipo_asiento:'ASI_PEN',fecha:'2026-10-31',mes_servicio:'2026-09',pais_servicio:'Jamaica'}
  ];
  const monthCompatible=normalizeJournalServiceMonths(source);
  const normalized=normalizeJournalServiceDimensions(source);
  assert.deepEqual(monthCompatible.map(row=>row.mes_servicio),['','','','2026-09']);
  assert.deepEqual(normalized.map(row=>row.mes_servicio),['','','','2026-09']);
  assert.deepEqual(normalized.map(row=>row.pais_servicio),[undefined,undefined,undefined,'Jamaica']);
  assert.ok(normalized.slice(0,3).every(row=>!Object.hasOwn(row,'pais_servicio')));
  assert.deepEqual(source.map(row=>row.mes_servicio),['1999-01','2030-12','invalid','2026-09']);
  assert.deepEqual(source.map(row=>row.pais_servicio),['Jamaica','CRI','ID:1','Jamaica']);
});
