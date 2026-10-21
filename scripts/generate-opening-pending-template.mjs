import ExcelJS from 'exceljs';
import {writeFile} from 'node:fs/promises';

const headers=[
 'referencia_pendiente','tipo_periodo','fecha_origen','identificacion_cliente','moneda','tipo_cambio_historico','cuenta',
 'debito_moneda_local','credito_moneda_local','debito_moneda_original','credito_moneda_original','es_linea_control',
 'mes_servicio','pais_servicio','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada','sucursal','nota','enlace_respaldo'
];
const examples=[
 ['PEN-ACTUAL-001','ACTUAL','2026-09-30','3-101-000001','JMD',1,'113003',100000,'',100000,'','SI','2026-09','JAM','Administrativo','CC-ADM','','','','','Servicios devengados del período actual','https://ejemplo.com/respaldo'],
 ['PEN-ACTUAL-001','ACTUAL','2026-09-30','3-101-000001','JMD',1,'413001','',100000,'',100000,'NO','2026-09','JAM','Administrativo','CC-ADM','','','','','Servicios devengados del período actual','https://ejemplo.com/respaldo'],
 ['PEN-ANTERIOR-001','ANTERIOR','2025-12-31','3-101-000001','USD',520,'113004',260000,'',500,'','SI','2025-12','CRI','Administrativo','CC-ADM','','','','','Pendiente procedente de períodos anteriores','https://ejemplo.com/respaldo-anterior'],
 ['PEN-ANTERIOR-001','ANTERIOR','2025-12-31','3-101-000001','USD',520,'413002','',260000,'',500,'NO','2025-12','CRI','Administrativo','CC-ADM','','','','','Pendiente procedente de períodos anteriores','https://ejemplo.com/respaldo-anterior']
];

const csvCell=value=>{const text=String(value??'');return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text};
await writeFile(
 new URL('../public/plantilla-saldos-pendientes-facturar.csv',import.meta.url),
 `\uFEFF${[headers,...examples].map(row=>row.map(csvCell).join(',')).join('\r\n')}\r\n`,
 'utf8'
);

const workbook=new ExcelJS.Workbook();
workbook.creator='GENTIA ERP';workbook.created=new Date('2026-10-21T00:00:00Z');
const sheet=workbook.addWorksheet('Pendientes de Facturar',{views:[{state:'frozen',ySplit:1}]});
sheet.addRows([headers,...examples]);sheet.autoFilter={from:'A1',to:`V${examples.length+1}`};sheet.getRow(1).height=36;
sheet.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF063B79'}};cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};cell.border={bottom:{style:'medium',color:{argb:'FFF26A3D'}}};});
sheet.columns=[22,16,16,23,11,21,13,22,22,24,24,18,16,16,20,18,16,21,22,16,43,39].map(width=>({width}));
for(let row=2;row<=5001;row++){
 sheet.getCell(row,2).dataValidation={type:'list',allowBlank:false,formulae:['"ACTUAL,ANTERIOR"']};
 sheet.getCell(row,3).numFmt='yyyy-mm-dd';sheet.getCell(row,12).dataValidation={type:'list',allowBlank:false,formulae:['"SI,NO"']};
 for(const column of[6,8,9,10,11])sheet.getCell(row,column).numFmt='#,##0.000000;[Red]-#,##0.000000';
}
for(let row=2;row<=examples.length+1;row++)sheet.getRow(row).alignment={vertical:'top',wrapText:true};
sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
sheet.headerFooter.oddFooter='GENTIA · Saldos iniciales · Pendientes de Facturar                                      Página &P de &N';

const instructions=workbook.addWorksheet('Instrucciones',{views:[{state:'frozen',ySplit:1}]});
instructions.columns=[{width:30},{width:108}];
instructions.addRows([
 ['Campo / regla','Descripción'],
 ['tipo_periodo','ACTUAL usa 113003 al debe y 413001 al haber. ANTERIOR usa 113004 al debe y 413002 al haber. Use el mismo valor en las dos líneas de cada referencia.'],
 ['Tasa histórica','Registre la tasa del reconocimiento original. El importe local debe ser igual al importe original multiplicado por esa tasa.'],
 ['Dos líneas por referencia','Cada pendiente requiere exactamente una línea de control al debe y una línea de contrapartida al haber, en moneda local y original.'],
 ['Reclasificación anual','Los pendientes ACTUAL vivos pueden reclasificarse el 01 de enero. GENTIA conserva la tasa original y mueve el control de 113003 a 113004 mediante 413002.'],
 ['Dimensiones','Departamento, centro de costos, clase, acreedor financiero, compañía relacionada y sucursal se conservan para las reversiones posteriores.'],
 ['Fechas y respaldo','Use fechas AAAA-MM-DD, mes de servicio AAAA-MM y, si aplica, un enlace http:// o https://.']
]);
instructions.getRow(1).height=26;instructions.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF063B79'}};});instructions.eachRow((row,index)=>{if(index>1)row.alignment={vertical:'top',wrapText:true};});

await workbook.xlsx.writeFile(new URL('../public/plantilla-saldos-pendientes-facturar.xlsx',import.meta.url));
console.log('Plantilla Excel de Pendientes de Facturar generada.');
