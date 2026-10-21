import ExcelJS from 'exceljs';

const headers=[
 'codigo_banco','numero_cuenta_bancaria','moneda','tipo_registro','fecha_movimiento','fecha_valor',
 'referencia','beneficiario','descripcion','importe_moneda_original','equivalente_moneda_local'
];
const examples=[
 ['BANK01','000123456789','USD','SALDO_CONCILIADO','2026-09-30','2026-09-30','SALDO-APERTURA','','Saldo conciliado según libros',50000,1000000],
 ['BANK01','000123456789','USD','DEPOSITO_EN_TRANSITO','2026-09-29','','DEP-001','Cliente ejemplo','Depósito pendiente de reflejar en el extracto',1200,24000],
 ['BANK01','000123456789','USD','CHEQUE_EN_TRANSITO','2026-09-28','','CHQ-001','Proveedor ejemplo','Cheque pendiente de cobro',800,16000]
];

const workbook=new ExcelJS.Workbook();
workbook.creator='GENTIA ERP';workbook.created=new Date('2026-10-21T00:00:00Z');
const sheet=workbook.addWorksheet('Auxiliar de Bancos',{views:[{state:'frozen',ySplit:1}]});
sheet.addRows([headers,...examples]);
sheet.autoFilter={from:'A1',to:'K4'};
sheet.getRow(1).height=32;
sheet.getRow(1).eachCell(cell=>{
 cell.font={bold:true,color:{argb:'FFFFFFFF'}};
 cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF063B79'}};
 cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
 cell.border={bottom:{style:'medium',color:{argb:'FFF26A3D'}}};
});
sheet.columns=[
 {width:17},{width:25},{width:12},{width:25},{width:19},{width:16},{width:20},{width:24},{width:42},{width:25},{width:25}
];
for(let row=2;row<=5001;row++){
 sheet.getCell(row,1).numFmt='@';sheet.getCell(row,2).numFmt='@';sheet.getCell(row,3).numFmt='@';
 sheet.getCell(row,4).dataValidation={type:'list',allowBlank:false,formulae:['"SALDO_CONCILIADO,DEPOSITO_EN_TRANSITO,CHEQUE_EN_TRANSITO"']};
 sheet.getCell(row,5).numFmt='yyyy-mm-dd';sheet.getCell(row,6).numFmt='yyyy-mm-dd';
 sheet.getCell(row,10).numFmt='#,##0.000000;[Red]-#,##0.000000';sheet.getCell(row,11).numFmt='#,##0.000000;[Red]-#,##0.000000';
}
for(let row=2;row<=4;row++)sheet.getRow(row).alignment={vertical:'top',wrapText:true};
sheet.getColumn(2).eachCell({includeEmpty:true},cell=>cell.numFmt='@');
sheet.getColumn(1).eachCell({includeEmpty:true},cell=>cell.numFmt='@');
sheet.getRow(1).eachCell(cell=>cell.numFmt='@');
sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
sheet.headerFooter.oddFooter='GENTIA · Carga de saldos iniciales · Auxiliar de Bancos                                      Página &P de &N';

const instructions=workbook.addWorksheet('Instrucciones');
instructions.columns=[{width:28},{width:105}];
instructions.addRows([
 ['Campo / regla','Descripción'],
 ['Banco y cuenta','Use codigo_banco y numero_cuenta_bancaria exactamente como aparecen en Bancos → Cuentas bancarias. Mantenga la cuenta como texto para conservar ceros iniciales.'],
 ['SALDO_CONCILIADO','Incluya una sola fila por cuenta. Puede ser positivo o negativo cuando exista un sobregiro. El importe original y el equivalente local deben tener el mismo signo.'],
 ['Partidas en tránsito','Digite DEPÓSITO_EN_TRANSITO y CHEQUE_EN_TRANSITO con importes positivos. GENTIA asigna automáticamente signo positivo al depósito y negativo al cheque.'],
 ['Fechas','Use AAAA-MM-DD. fecha_valor puede dejarse vacía; ninguna fecha puede ser posterior a la fecha de apertura.'],
 ['Importes','No utilice separadores de miles. Puede usar hasta seis decimales. equivalente_moneda_local representa la conversión histórica del importe original.'],
 ['Conciliación','El auxiliar conserva el saldo operativo y las partidas pendientes para la primera conciliación. No vuelve a contabilizar los importes del Libro Mayor.']
]);
instructions.getRow(1).height=26;
instructions.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF063B79'}};});
instructions.eachRow((row,index)=>{if(index>1)row.alignment={vertical:'top',wrapText:true};});
instructions.views=[{state:'frozen',ySplit:1}];

await workbook.xlsx.writeFile(new URL('../public/plantilla-saldos-bancos.xlsx',import.meta.url));
console.log('Plantilla Excel del Auxiliar de Bancos generada.');
