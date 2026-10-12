import assert from 'node:assert/strict';
import { parseOpeningAccountingCsv } from '../dist/modules/accounting-catalogs/opening-balances.service.js';

const canonical = [
  'cuenta,debito_moneda_local,credito_moneda_local,moneda,debito_moneda_original,credito_moneda_original,departamento,centro_costos,clase,acreedor_financiero,compania_relacionada,sucursal,nota',
  '110001,1000000,,USD,50000,,Administrativo,CC-ADM,Operativa,Banco Uno,Relacionada Uno,,Saldo inicial',
].join('\n');
const [line] = parseOpeningAccountingCsv(canonical, 'GL');
assert.deepEqual(line, {
  sourceType: 'GL',
  sourceRow: 2,
  account: '110001',
  documentNumber: '',
  issueDate: '',
  dueDate: '',
  currency: 'USD',
  debit: '1000000',
  credit: '',
  debitFx: '50000',
  creditFx: '',
  entityTaxId: '',
  department: 'Administrativo',
  costCenter: 'CC-ADM',
  className: 'Operativa',
  financialCreditor: 'Banco Uno',
  relatedCompany: 'Relacionada Uno',
  location: '',
  note: 'Saldo inicial',
});

const friendlyHeaders = [
  'Cuenta;Débito Moneda Local;Crédito Moneda Local;Moneda Original;Débito Moneda Origen;Crédito Moneda Origen;Departamento;Centro de Costos;Clase;Acreedores Financieros;Compañías Relacionadas;Ubicación;Nota',
  '210001;;900000;USD;;45000;Administrativo;CC-ADM;;Banco Dos;Relacionada Dos;Oficina Central;Saldo pasivo',
].join('\n');
const [friendly] = parseOpeningAccountingCsv(friendlyHeaders, 'GL');
assert.equal(friendly.credit, '900000');
assert.equal(friendly.creditFx, '45000');
assert.equal(friendly.currency, 'USD');
assert.equal(friendly.costCenter, 'CC-ADM');
assert.equal(friendly.financialCreditor, 'Banco Dos');
assert.equal(friendly.relatedCompany, 'Relacionada Dos');
assert.equal(friendly.location, 'Oficina Central');
assert.ok(!('project' in friendly));

const receivable = [
  'identificacion_tercero,numero_documento,fecha_emision,fecha_vencimiento,cuenta,moneda,saldo,centro_costos,sucursal,nota',
  '3-101-1,FAC-1,2026-01-01,2026-02-01,120001,USD,500,CC-COM,,Factura inicial',
].join('\n');
const [ar] = parseOpeningAccountingCsv(receivable, 'AR');
assert.equal(ar.debit, '500');
assert.equal(ar.credit, '');
assert.ok(!('project' in ar));

assert.throws(
  () => parseOpeningAccountingCsv('Cuenta,cuenta,debito_moneda_local\n110001,110001,1', 'GL'),
  /encabezados duplicados/,
  'Los encabezados duplicados deben detectarse después de normalizar mayúsculas y tildes.',
);

console.log('OK: parser de apertura conserva importes local/original, dimensiones y aliases; Proyecto fue retirado.');
