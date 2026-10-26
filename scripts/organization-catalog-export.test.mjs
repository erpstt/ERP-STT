import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildOrganizationCatalogCsv,
  buildOrganizationCatalogExcel,
} from '../dist/modules/organization-catalogs/organization-catalog-export.service.js';

const catalog={
  slug:'departments',
  title:'Departamentos',
  description:'Departamentos y segmentación analítica',
  primaryKey:'department_id',
  fields:[],
};

const columns=[
  {key:'department_id',label:'ID interno',type:'number',width:14},
  {key:'name',label:'Nombre',type:'text',width:32},
  {key:'parent_id',label:'Departamento padre',type:'text',reference:'organization/departments',width:28},
  {key:'subsidiary_ids',label:'Subsidiarias',type:'multi-reference',reference:'organization/subsidiaries',width:42},
  {key:'is_inactive',label:'Inactivo',type:'boolean',width:16},
];

const rows=[{
  department_id:7,
  name:'=HYPERLINK("https://example.test","ADMINISTRACIÓN")',
  parent_id:'GESTIÓN REGIONAL',
  subsidiary_ids:'Compañía Costa Rica, S.A. | S.T.T. HOLDINGS LIMITED',
  is_inactive:'No',
}];

test('CSV genérico de Organización usa UTF-8, CRLF y neutraliza fórmulas',()=>{
  const csv=buildOrganizationCatalogCsv(columns,rows).toString('utf8');
  const lines=csv.split('\r\n');

  assert.ok(csv.startsWith('\uFEFF'));
  assert.equal(lines.length,2);
  assert.equal(lines[0].replace(/^\uFEFF/,''),'"ID interno","Nombre","Departamento padre","Subsidiarias","Inactivo"');
  assert.match(csv,/"'=HYPERLINK\(""https:\/\/example\.test"",""ADMINISTRACIÓN""\)"/);
  assert.match(csv,/"GESTIÓN REGIONAL"/);
  assert.match(csv,/"Compañía Costa Rica, S\.A\. \| S\.T\.T\. HOLDINGS LIMITED"/);
});

test('Excel genérico de Organización es un XLSX profesional, filtrable y conserva tipos',async()=>{
  const buffer=await buildOrganizationCatalogExcel(
    catalog,
    columns,
    rows,
    '2 subsidiarias autorizadas',
    'administración',
  );
  assert.equal(buffer.subarray(0,2).toString(),'PK');

  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.creator,'GENTIA ERP');
  assert.equal(workbook.company,'2 subsidiarias autorizadas');

  const sheet=workbook.getWorksheet('Departamentos');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A1').value,'GENTIA · DEPARTAMENTOS');
  assert.equal(sheet.getCell('A2').value,'Alcance: 2 subsidiarias autorizadas');
  assert.match(String(sheet.getCell('A3').value),/1 registro/);
  assert.match(String(sheet.getCell('A3').value),/administración/);
  assert.equal(sheet.getCell('A5').value,'ID interno');
  assert.equal(sheet.getCell('E5').value,'Inactivo');
  assert.equal(sheet.getCell('A6').value,7);
  assert.equal(typeof sheet.getCell('A6').value,'number');
  assert.equal(sheet.getCell('B6').value,`'${rows[0].name}`);
  assert.equal(sheet.getCell('C6').value,'GESTIÓN REGIONAL');
  assert.equal(sheet.getCell('E6').value,'No');
  assert.equal(sheet.views[0].state,'frozen');
  assert.equal(sheet.views[0].ySplit,5);
  assert.equal(sheet.getTables().length,1);
  assert.equal(sheet.autoFilter,'A5:E5');
});
