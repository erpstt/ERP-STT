import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';
import { customerPaymentDetail } from './customer-payment.service.js';

type JsonObject=Record<string,unknown>;

const object=(value:unknown):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};
const array=(value:unknown):JsonObject[]=>Array.isArray(value)?value.map(object):[];
const text=(value:unknown,fallback='—')=>String(value??'').trim()||fallback;
const number=(value:unknown)=>{const parsed=Number(value??0);return Number.isFinite(parsed)?parsed:0;};
const escapeHtml=(value:unknown)=>text(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const safeFileName=(value:unknown,fallback='cobro')=>String(value??'').replace(/[\\/\r\n\0<>:"|?*]/g,'-').trim().slice(0,150)||fallback;
const date=(value:unknown)=>{
  const iso=String(value??'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return'—';
  return new Intl.DateTimeFormat('es-CR',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${iso}T12:00:00Z`));
};
const rate=(value:unknown)=>number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:10});

function field(row:JsonObject,...keys:string[]){
  for(const key of keys)if(row[key]!==undefined&&row[key]!==null)return row[key];
  return undefined;
}

function paymentAmounts(detail:JsonObject){
  const header=object(detail.header),applications=array(detail.applications),advances=array(detail.advances),fee=object(detail.bankFee);
  const applied=applications.reduce((sum,row)=>sum+number(field(row,'amount')),0);
  const advance=advances.reduce((sum,row)=>sum+number(field(row,'amount')),0);
  const bankFee=number(field(fee,'amount','bank_fee_amount'));
  const receivedBeforeAdvancesAndFee=number(field(header,'amount_received'));
  const withholding=Math.max(applied-receivedBeforeAdvancesAndFee,0);
  const bankNet=Math.max(receivedBeforeAdvancesAndFee-advance-bankFee,0);
  return{applied,advance,bankFee,withholding,bankNet};
}

function tableEmpty(columns:number,label:string){return`<tr><td class="empty" colspan="${columns}">${escapeHtml(label)}</td></tr>`;}

export function buildCustomerPaymentPdfHtml(input:unknown){
  const detail=object(input),header=object(detail.header),applications=array(detail.applications),advances=array(detail.advances),impact=array(detail.impact),fee=object(detail.bankFee);
  const paymentNumber=text(field(header,'payment_number'),'Cobro'),company=text(field(header,'subsidiary'),'Subsidiaria'),customer=text(field(header,'customer'),'Cliente'),currency=text(field(header,'currency'),''),amounts=paymentAmounts(detail);
  if(!applications.length)throw Error('El cobro no contiene facturas aplicadas para generar el PDF.');
  const money=(value:unknown)=>`${currency?`${currency} `:''}${number(value).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const applicationRows=applications.map(row=>`<tr><td><b>${escapeHtml(field(row,'invoiceNumber','invoice_number'))}</b></td><td class="num">${escapeHtml(money(field(row,'invoiceTotal','invoice_total')))}</td><td class="num strong">${escapeHtml(money(field(row,'amount')))}</td></tr>`).join('');
  const advanceRows=advances.map(row=>`<tr><td><b>${escapeHtml(field(row,'number','journal_number'))}</b></td><td>${escapeHtml(date(field(row,'date','journal_date')))}</td><td>${escapeHtml(field(row,'account','account_number'))}</td><td class="num strong">${escapeHtml(money(field(row,'amount')))}</td></tr>`).join('');
  let totalDebit=0,totalCredit=0;
  const impactRows=impact.map(row=>{const debit=number(field(row,'debit')),credit=number(field(row,'credit'));totalDebit+=debit;totalCredit+=credit;return`<tr><td><b>${escapeHtml(field(row,'accountNumber','account_number'))}</b></td><td>${escapeHtml(field(row,'accountName','account_name'))}</td><td class="num">${escapeHtml(money(debit))}</td><td class="num">${escapeHtml(money(credit))}</td></tr>`}).join('');
  const balanced=Math.abs(totalDebit-totalCredit)<.005;
  const status=text(field(header,'status'),'CONTABILIZADO').replaceAll('_',' ').toUpperCase();
  const optionalMetrics=[
    amounts.withholding>0?`<div><span>Retenciones aplicadas</span><b>${escapeHtml(money(amounts.withholding))}</b></div>`:'',
    amounts.advance>0?`<div><span>Anticipos aplicados</span><b>${escapeHtml(money(amounts.advance))}</b></div>`:'',
    amounts.bankFee>0?`<div class="fee"><span>Comisión bancaria</span><b>${escapeHtml(money(amounts.bankFee))}</b></div>`:''
  ].join('');
  const metricCount=2+Number(amounts.withholding>0)+Number(amounts.advance>0)+Number(amounts.bankFee>0);
  const feeAccount=amounts.bankFee>0?`${text(field(fee,'expenseAccountNumber','expense_account_number'),'')} · ${text(field(fee,'expenseAccountName','expense_account_name'),'')}`.replace(/^\s*·\s*$/,'—'):'—';

  return`<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  @page{size:A4 portrait;margin:12mm 13mm 14mm}*{box-sizing:border-box}body{margin:0;color:#14233b;font:11px Arial,Helvetica,sans-serif}.document{width:100%}header{display:flex;justify-content:space-between;gap:28px;padding-bottom:17px;border-bottom:4px solid #ef6a3a}.brand{display:flex;align-items:center;gap:13px;min-width:0}.brand-mark{width:48px;height:48px;display:grid;place-items:center;border-radius:12px;background:#07356f;color:#fff;font-size:20px;font-weight:900;letter-spacing:-1px}.brand small{display:block;margin-bottom:5px;color:#0b8060;font-size:8px;font-weight:bold;letter-spacing:.16em}.brand h1{margin:0;font-size:19px;line-height:1.1}.identity{text-align:right}.identity>small{color:#07356f;font-size:8px;font-weight:bold;letter-spacing:.18em}.identity h2{margin:7px 0 6px;font-size:19px;line-height:1.1}.status{display:inline-block;padding:4px 10px;border-radius:999px;background:#e7f6ef;color:#087252;font-size:8px;font-weight:bold}.overview{display:grid;grid-template-columns:1.15fr 1fr;gap:22px;margin:20px 0 16px}.party{padding:15px 16px;border-radius:10px;background:#f3f7fb;border-left:4px solid #07356f}.eyebrow{margin:0 0 7px;color:#60738a;font-size:8px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase}.party strong{display:block;font-size:16px}.party p{margin:7px 0 0;color:#53657a;line-height:1.45}.facts{margin:0}.facts div{display:flex;justify-content:space-between;gap:16px;padding:6px 0;border-bottom:1px solid #dfe7ef}.facts dt{color:#65768b}.facts dd{margin:0;text-align:right;font-weight:bold}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:0 0 20px}.metrics div{min-height:62px;padding:10px;border:1px solid #dce5ee;border-radius:8px;background:#fff}.metrics span,.metrics b{display:block}.metrics span{color:#697a8f;font-size:8px;line-height:1.25}.metrics b{margin-top:7px;font-size:13px}.metrics .fee{border-color:#f1c8aa;background:#fff9f4}.metrics .net{border-color:#a7d8c7;background:#ebf8f3}.metrics .net b{color:#087252;font-size:15px}.section{margin-top:18px;break-inside:auto}.section-title{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:7px;padding-bottom:6px;border-bottom:2px solid #07356f}.section-title h3{margin:0;font-size:12px}.section-title span{color:#6c7c90;font-size:8px}.section-title .ok{color:#087252;font-weight:bold}.section-title .bad{color:#b42332;font-weight:bold}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid}th{padding:8px 7px;background:#eaf0f6;color:#53657a;font-size:8px;text-align:left;text-transform:uppercase;letter-spacing:.04em}td{padding:8px 7px;border-bottom:1px solid #e1e7ee;vertical-align:top}td.empty{text-align:center;color:#718096;padding:13px}.num{text-align:right;white-space:nowrap}.strong{font-weight:bold}.accounting th:nth-child(1){width:17%}.accounting th:nth-child(2){width:47%}.accounting th:nth-child(3),.accounting th:nth-child(4){width:18%}.table-total td{border-top:2px solid #9eacba;background:#f7f9fb;font-weight:bold}.notes{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.note{min-height:64px;padding:11px 13px;border:1px solid #dfe6ed;border-radius:8px}.note b{display:block;margin-bottom:5px;color:#53657a;font-size:8px;text-transform:uppercase;letter-spacing:.08em}.note p{margin:0;white-space:pre-wrap;line-height:1.45}.commission{background:#fff9f4;border-color:#f1c8aa}footer{display:flex;justify-content:space-between;gap:20px;margin-top:30px;padding-top:9px;border-top:1px solid #d7dfe8;color:#718096;font-size:8px}.muted{color:#718096}
  </style></head><body><main class="document"><header><div class="brand"><div class="brand-mark">GE</div><div><small>GENTIA ERP</small><h1>${escapeHtml(company)}</h1></div></div><div class="identity"><small>COMPROBANTE DE COBRO</small><h2>${escapeHtml(paymentNumber)}</h2><span class="status">${escapeHtml(status)}</span></div></header><section class="overview"><div class="party"><p class="eyebrow">Recibido de</p><strong>${escapeHtml(customer)}</strong><p>Referencia bancaria: <b>${escapeHtml(field(header,'bank_reference'))}</b></p></div><dl class="facts"><div><dt>Fecha del cobro</dt><dd>${escapeHtml(date(field(header,'payment_date')))}</dd></div><div><dt>Banco</dt><dd>${escapeHtml(field(header,'bank'))}</dd></div><div><dt>Cuenta bancaria</dt><dd>${escapeHtml(field(header,'account'))}</dd></div><div><dt>Moneda</dt><dd>${escapeHtml(currency||'—')}</dd></div><div><dt>Tipo de cambio</dt><dd>${escapeHtml(rate(field(header,'exchange_rate')))}</dd></div><div><dt>Ubicación</dt><dd>${escapeHtml(field(header,'location'))}</dd></div></dl></section><section class="metrics" style="grid-template-columns:repeat(${metricCount},minmax(0,1fr))"><div><span>Total aplicado a facturas</span><b>${escapeHtml(money(amounts.applied))}</b></div>${optionalMetrics}<div class="net"><span>Ingreso bancario neto</span><b>${escapeHtml(money(amounts.bankNet))}</b></div></section><section class="section"><div class="section-title"><h3>Facturas aplicadas</h3><span>${applications.length} documento${applications.length===1?'':'s'}</span></div><table><thead><tr><th>Factura</th><th class="num">Total de la factura</th><th class="num">Importe aplicado</th></tr></thead><tbody>${applicationRows||tableEmpty(3,'No existen facturas aplicadas.')}<tr class="table-total"><td colspan="2">Total aplicado</td><td class="num">${escapeHtml(money(amounts.applied))}</td></tr></tbody></table></section>${advances.length?`<section class="section"><div class="section-title"><h3>Anticipos de clientes aplicados</h3><span>${advances.length} registro${advances.length===1?'':'s'}</span></div><table><thead><tr><th>Asiento origen</th><th>Fecha</th><th>Cuenta</th><th class="num">Importe aplicado</th></tr></thead><tbody>${advanceRows}<tr class="table-total"><td colspan="3">Total anticipos</td><td class="num">${escapeHtml(money(amounts.advance))}</td></tr></tbody></table></section>`:''}<section class="section"><div class="section-title"><h3>Impacto contable</h3><span class="${balanced?'ok':'bad'}">${balanced?'ASIENTO CUADRADO':`DIFERENCIA ${escapeHtml(money(totalDebit-totalCredit))}`}</span></div><table class="accounting"><thead><tr><th>Cuenta</th><th>Nombre</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead><tbody>${impactRows||tableEmpty(4,'No existe impacto contable registrado.')}<tr class="table-total"><td colspan="2">Totales</td><td class="num">${escapeHtml(money(totalDebit))}</td><td class="num">${escapeHtml(money(totalCredit))}</td></tr></tbody></table></section><section class="notes"><div class="note"><b>Nota del cobro</b><p>${escapeHtml(field(header,'memo'))}</p></div>${amounts.bankFee>0?`<div class="note commission"><b>Registro de comisión bancaria</b><p>${escapeHtml(money(amounts.bankFee))} contabilizados en ${escapeHtml(feeAccount)}.</p></div>`:`<div class="note"><b>Validación</b><p>El cobro no registra comisión bancaria.</p></div>`}</section><footer><span>${escapeHtml(company)} · ${escapeHtml(paymentNumber)}</span><span>Comprobante generado electrónicamente desde GENTIA ERP</span></footer></main></body></html>`;
}

export function renderCustomerPaymentPdf(detail:unknown){
  const header=object(object(detail).header),number=text(field(header,'payment_number'),'cobro');
  return renderBankReconciliationPdf({
    html:buildCustomerPaymentPdfHtml(detail),
    fileName:`comprobante-cobro-${safeFileName(number)}.pdf`
  });
}

export async function downloadCustomerPaymentPdf(authorization:string,paymentId:number){
  if(!Number.isSafeInteger(paymentId)||paymentId<=0)throw Error('El cobro indicado no es válido.');
  const detail=await customerPaymentDetail(authorization,paymentId);
  const header=object(object(detail).header);
  if(!header.payment_id||Number(header.payment_id)!==paymentId)throw Error('No se encontró el cobro en la subsidiaria activa.');
  return renderCustomerPaymentPdf(detail);
}
