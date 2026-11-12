// Operator-only smoke test: no database access, invoice data or SMTP, and no secret values in output.
import {pdfRendererConfig} from '../dist/core/security/pdf-renderer.js';
import {renderSalesInvoicePdf} from '../dist/modules/notifications/sales-invoice-delivery.service.js';
const report={remoteConfigured:false,tokenConfigured:Boolean(process.env.PDF_RENDERER_TOKEN)};
const reason=e=>['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(e?.cause?.code)?e.cause.code:e?.name==='TimeoutError'?'TIMEOUT':'FAILED';
try{
 const config=pdfRendererConfig();report.remoteConfigured=Boolean(config);
 if(config){
  try{const health=await fetch(new URL('/health',config.url),{signal:AbortSignal.timeout(20000)});report.healthStatus=health.status;const body=await health.json().catch(()=>({}));report.workerReady=body.status==='ready';}catch(e){report.healthError=reason(e);}
  try{const direct=await fetch(config.url,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify({html:'<!doctype html><html><body><p>GENTIA synthetic PDF check</p></body></html>'}),signal:AbortSignal.timeout(30000)});report.renderStatus=direct.status;report.renderMime=direct.headers.get('content-type')?.split(';')[0];if(direct.ok){const bytes=Buffer.from(await direct.arrayBuffer());report.renderPdf=bytes.subarray(0,4).toString()==='%PDF';report.renderBytes=bytes.length;}else await direct.body?.cancel();}catch(e){report.renderError=reason(e);}
 }
 const document={id:1,number:'SYNTHETIC-PDF-CHECK',issueDate:'2026-11-12',dueDate:'2026-11-12',memo:'Synthetic diagnostic document',total:10,receivable:10,company:{name:'Synthetic company',address:''},customer:{name:'Synthetic customer',email:'example@example.invalid',address:'',taxId:''},currency:{code:'USD',name:'US Dollar',symbol:'$'},paymentTerm:'',withholdingTotal:0,lines:[{product:'Synthetic service',description:'Synthetic service',serviceCountry:'Costa Rica',quantity:1,unitPrice:10,amount:10,taxRate:0,taxAmount:0,grossAmount:10}],supports:[]};
 try{const result=await renderSalesInvoicePdf(document);const bytes=Buffer.from(result.base64,'base64');report.invoicePdf=bytes.subarray(0,4).toString()==='%PDF';report.invoiceBytes=bytes.length;}catch(e){report.invoicePdf=false;report.invoiceError=reason(e);}
}catch(e){report.configurationError=reason(e);}
console.log('PDF_DIAGNOSTICS '+JSON.stringify(report));
