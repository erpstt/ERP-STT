import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {parseOpeningPendingCsv,parseOpeningPendingFile} from '../dist/modules/accounting-catalogs/opening-balances.service.js';

const headers=['referencia_pendiente','fecha_origen','identificacion_cliente','moneda','tipo_cambio_historico','cuenta','debito_moneda_local','credito_moneda_local','debito_moneda_original','credito_moneda_original','es_linea_control','mes_servicio','pais_servicio','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada','sucursal','nota','url_respaldo'];
const data=[
 ['PEN-INI-001','2026-09-30','111','JMD','1','113003','100000','','100000','','SI','2026-09','JAM','Administrativo','CC-ADM','','','','','Saldo inicial','https://example.com/respaldo.pdf'],
 ['PEN-INI-001','2026-09-30','111','JMD','1','413001','','100000','','100000','NO','2026-09','JAM','Administrativo','CC-ADM','','','','','Saldo inicial','https://example.com/respaldo.pdf']
];

function csv(rows=data){return[headers,...rows].map(row=>row.join(',')).join('\n');}

test('agrupa las dos líneas y conserva el respaldo del pendiente',()=>{
 const result=parseOpeningPendingCsv(csv(),'2026-09-30');
 assert.equal(result.length,1);
 assert.equal(result[0].reference,'PEN-INI-001');
 assert.equal(result[0].supportUrl,'https://example.com/respaldo.pdf');
 assert.deepEqual(result[0].lines.map(line=>[line.account,line.isControlLine]),[['113003',true],['413001',false]]);
});

test('rechaza una composición distinta a Dr 113003 / Cr 413001',()=>{
 const invalid=structuredClone(data);invalid[0][6]='';invalid[0][7]='100000';
 assert.throws(()=>parseOpeningPendingCsv(csv(invalid),'2026-09-30'),/113003 debe llevar el débito local y original/);
});

test('acepta una tasa histórica con tres decimales',()=>{
 const withPreciseRate=structuredClone(data);
 for(const row of withPreciseRate){row[4]='2.500';row[6]=row[6]?'100':'';row[7]=row[7]?'100':'';row[8]=row[8]?'40':'';row[9]=row[9]?'40':'';}
 const result=parseOpeningPendingCsv(csv(withPreciseRate),'2026-09-30');
 assert.equal(result[0].exchangeRate,'2.500');
});

test('acepta un XLSX Base64 con el mismo contrato que el CSV',async()=>{
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Pendientes');sheet.addRows([headers,...data]);
 const content=await workbook.xlsx.writeBuffer();
 const result=await parseOpeningPendingFile({fileName:'pendientes.xlsx',base64:Buffer.from(content).toString('base64')},'2026-09-30');
 assert.equal(result.length,1);assert.equal(result[0].lines.length,2);
});
