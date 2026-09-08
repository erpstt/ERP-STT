import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { journalCsvHeaders, parseJournalCsv } from '../dist/modules/accounting-catalogs/journal-import.service.js';
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
  const expanded=parseJournalCsv(`${fullHeader}\n${line},Cliente,Cliente ejemplo,Servicios,Proyecto,Consultoria,Banco,Relacionada`)[0];
  assert.equal(expanded.entidad,'Cliente'); assert.equal(expanded.nombre,'Cliente ejemplo');
  assert.equal(expanded.departamento,'Servicios'); assert.equal(expanded.centro_costos,'Proyecto');
  assert.equal(expanded.clase,'Consultoria'); assert.equal(expanded.acreedor_financiero,'Banco'); assert.equal(expanded.compania_relacionada,'Relacionada');
  assert.deepEqual(parseJournalCsv(`${fullHeader}\n${line},,,,,,,`),parseJournalCsv(`${header}\n${line}`));
});
