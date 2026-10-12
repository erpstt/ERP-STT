import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const readText = (path) => readFile(new URL(path, root), 'utf8');
const [html, client, service, templateBytes] = await Promise.all([
  readText('public/opening-balances.html'),
  readText('public/opening-balances.js'),
  readText('src/modules/accounting-catalogs/opening-balances.service.ts'),
  readFile(new URL('public/plantilla-saldos-activos-fijos.csv', root)),
]);

assert.match(html, /Auxiliar de Activos Fijos/);
assert.match(html, /href="\/plantilla-saldos-activos-fijos\.csv" download/);
assert.match(html, /id="fa" type="file"/);
assert.match(html, /Mayor.*Auxiliar.*Diferencia/s);

assert.deepEqual(
  [...templateBytes.subarray(0, 3)],
  [0xef, 0xbb, 0xbf],
  'La plantilla debe incluir BOM UTF-8 para abrir correctamente en Excel.',
);
const template = templateBytes.toString('utf8').replace(/^\uFEFF/, '');
const templateLines = template.split(/\r?\n/).filter((line) => line.trim() !== '');
assert.equal(templateLines.length, 1, 'La plantilla descargable debe contener solo el encabezado, sin activos de ejemplo.');

const headers = templateLines[0].split(',');
const expectedHeaders = [
  'codigo_activo',
  'nombre_activo',
  'codigo_categoria',
  'numero_serie',
  'descripcion',
  'fecha_compra',
  'fecha_en_servicio',
  'costo_historico',
  'depreciacion_acumulada',
  'valor_en_libros',
  'meses_depreciados',
  'ubicacion',
  'tipo_departamento',
  'departamento',
  'centro_costos',
  'clase',
  'estado',
  'moneda',
  'nota',
];
assert.deepEqual(headers, expectedHeaders);

assert.match(service, /text\.replace\(\/\^\\uFEFF\//);
assert.match(service, /if\(records\.length<2\)return\[\]/);
assert.match(service, /excelSeparator/);
assert.match(service, /encabezados duplicados/);
assert.match(service, /más columnas que el encabezado/);
assert.match(service, /importe .* es ambiguo/);
assert.match(service, /function fixedAssetCsv\(text:string\)/);
assert.match(service, /const required=\['nombre_activo'.*'moneda'\]/s);
assert.match(service, /const financialRows=\[\.\.\.accountingCsv\(String\(p\.gl/);
assert.match(service, /const assets=fixedAssetCsv\(String\(p\.fa/);
assert.match(service, /rows:financialRows,assets/);
assert.match(service, /expectedSubsidiaryId:p\.expectedSubsidiaryId/);

assert.match(client, /row\.existing/);
assert.match(client, /row\.staged/);
assert.match(client, /row\.auxiliary/);
assert.match(client, /if\(posted\)fa=await read\('fa'\)/);
assert.match(client, /else\[gl,ar,ap,fa\]=await Promise\.all\(\['gl','ar','ap','fa'\]\.map\(read\)\)/);
assert.match(client, /function invalidateValidation\(\)/);
assert.match(client, /\['date','type','transition'\].*addEventListener\('change',invalidateValidation\)/s);
assert.match(client, /run\.status!=='VALIDATED'/);
assert.match(client, /canCreate=data\.canCreate===true/);
assert.match(client, /canReverse=data\.canReverse===true/);
assert.match(client, /\$\('validate'\)\.disabled=!canCreate/);
assert.match(client, /for\(const id of \['gl','ar','ap'\]\)/);
assert.match(client, /\$\(id\)\.disabled=!canCreate\|\|posted/);
assert.match(client, /\$\(id\)\.value=''/);
assert.match(client, /Cargar auxiliar de activos/);
assert.match(client, /\$\('reverse'\)\.hidden=!canReverse\|\|!posted/);
assert.match(client, /!transitionAccounts\.length&&existingRun\?\.status!=='POSTED'/);
assert.match(client, /Cuenta usada en la apertura contabilizada/);
assert.match(client, /function assertActiveCompany\(\)/);
assert.match(client, /expectedSubsidiaryId:subsidiaryId/);
assert.match(client, /function beginWork\(\)/);
assert.match(client, /function endWork\(state\)/);

console.log(
  'OK: plantilla vacía con BOM, carga combinada, conciliación existente/nueva y carga posterior solo del auxiliar están cubiertas en la interfaz.',
);
