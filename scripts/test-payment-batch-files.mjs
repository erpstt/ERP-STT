import assert from 'node:assert/strict';
import { buildPaymentBatchFile, parsePaymentBatchResponse } from '../dist/modules/treasury-catalogs/payment-batches.service.js';

const base = {
  header: {
    id: 7,
    number: 'PAY-BATCH-2026-000007',
    executionDate: '2026-10-03',
    currency: 'CRC',
    bank: 'Banco de prueba',
    account: '1234567890',
    accountIban: 'CR05000000000000000001',
    formatCode: '',
    formatName: '',
    extension: '',
    encoding: 'UTF-8'
  },
  items: [
    { id: 1, lineNumber: 1, lineReference: 'PB7-00001', requestId: 11, requestNumber: 'SOL-PAG-11', supplier: 'Proveedor Ágil S.A.', taxId: '3-101-123456', idType: 'J', iban: 'CR05015200000000000002', amount: 10.5 },
    { id: 2, lineNumber: 2, lineReference: 'PB7-00002', requestId: 12, requestNumber: 'SOL-PAG-12', supplier: 'Proveedor Dos', taxId: '1-1234-5678', idType: 'F', iban: 'CR05010200000000000003', amount: 20.25 }
  ]
};

const formats = [
  { strategy: 'BAC', code: 'BAC_CR_PAYROLL_TXT', extension: '.txt', marker: '"H","PAY-BATCH-2026-000007"', amountMarker: '30.75' },
  { strategy: 'BNCR', code: 'BNCR_CONEXION_TXT', extension: '.txt', marker: 'PB7-00001', amountMarker: '000000000000003075' },
  { strategy: 'BCR', code: 'BCR_EN_LINEA_CSV', extension: '.csv', marker: '"REFERENCIA_ERP"', amountMarker: '20.25' },
  { strategy: 'SINPE', code: 'SINPE_GENERIC_XML', extension: '.xml', marker: '<ReferenciaERP>PB7-00001</ReferenciaERP>', amountMarker: '30.75' }
];

for (const format of formats) {
  const detail = {
    ...base,
    header: {
      ...base.header,
      formatCode: format.code,
      formatName: format.code,
      extension: format.extension,
      structureDefinition: { strategy: format.strategy, recordDelimiter: 'CRLF' }
    }
  };
  const file = buildPaymentBatchFile(detail);
  const content = file.buffer.toString('utf8');
  assert.equal(file.fileName, `${base.header.number}${format.extension}`);
  assert.ok(content.includes(format.marker), `${format.code} no incluyó su estructura esperada.`);
  assert.ok(content.includes(format.amountMarker), `${format.code} no incluyó el total en la representación esperada.`);
  assert.ok(content.includes('PB7-00002'), `${format.code} omitió la segunda transferencia.`);
  if (format.strategy !== 'BAC') assert.ok(content.includes('0152'), `${format.code} omitió el código de banco destino derivado del IBAN.`);
}

const csvResponse = parsePaymentBatchResponse(
  'REFERENCIA_ERP,ESTADO,REFERENCIA_BANCO,MOTIVO\nPB7-00001,APROBADO,BAC-123,\nPB7-00002,RECHAZADO,,IBAN inválido\n',
  { delimiter: ',' }
);
assert.equal(csvResponse.length, 2);
assert.deepEqual(csvResponse[0], { lineReference: 'PB7-00001', status: 'APROBADO', bankReference: 'BAC-123', reason: '', code: '' });
assert.equal(csvResponse[1].reason, 'IBAN inválido');

const xmlResponse = parsePaymentBatchResponse(
  '<Respuesta><Pago><ReferenciaERP>PB7-00001</ReferenciaERP><Estado>PROCESADO</Estado><ReferenciaBanco>SINPE-99</ReferenciaBanco></Pago></Respuesta>'
);
assert.equal(xmlResponse.length, 1);
assert.equal(xmlResponse[0].lineReference, 'PB7-00001');
assert.equal(xmlResponse[0].bankReference, 'SINPE-99');

console.log(JSON.stringify({ builders: formats.map(item => item.strategy), delimitedResponse: true, xmlResponse: true }));
