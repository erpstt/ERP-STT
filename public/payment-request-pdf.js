import {downloadDocumentPdf} from './document-pdf-download.js?v=20261111-export-review';

// Build text-only content from the saved request, never from an unsaved form.
export async function downloadPaymentRequestPdf(detail,options){
 const h=detail.header,root=document.createElement('section');
 const add=(tag,text)=>{const node=document.createElement(tag);node.textContent=text??'—';root.append(node);return node;};
 const name=(rows,id)=>rows?.find(row=>String(row.id)===String(id))?.name||'—';
 const amount=value=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
 const currency=name(options.currencies,h.id_moneda);
 add('h2',h.numero);add('p',`Estado: ${h.estado.replaceAll('_',' ')}`);
 add('p',`Tipo: ${h.tipo_solicitud==='CXP'?'Pago de CxP':'Otros Pagos'}`);
 add('p',`Solicitante: ${name(options.users,h.id_solicitante)}`);
 add('p',`Fecha de solicitud: ${h.fecha_solicitud} · Pago programado: ${h.fecha_pago_programada||'—'}`);
 if(h.id_proveedor)add('p',`Proveedor: ${name(options.suppliers,h.id_proveedor)}`);
 add('h2','Concepto general');add('p',h.concepto);
 const cxp=h.tipo_solicitud==='CXP';add('h2',cxp?'Facturas seleccionadas':'Imputaciones contables');
 const table=document.createElement('table'),head=table.createTHead().insertRow();
 for(const label of cxp?['Factura','Emisión','Vencimiento','Monto original','Monto solicitado']:['Cuenta contable','Tercero','Departamento','Centro de costo / Proyecto','Concepto','Monto solicitado']){const cell=document.createElement('th');cell.textContent=label;head.append(cell);}
 const body=table.createTBody();
 for(const line of detail.lines){const row=body.insertRow(),values=cxp?[line.invoiceNumber,line.invoiceDate,line.invoiceDueDate,amount(line.invoiceTotal),amount(line.monto)]:[line.accountName,line.party,line.department,line.costCenter,line.concepto,amount(line.monto)];values.forEach((value,index)=>{const cell=row.insertCell();cell.textContent=value||'—';if(index===values.length-1||(cxp&&index===3))cell.className='num';});}
 root.append(table);add('h2',`Total solicitado: ${amount(h.total)} ${currency}`);
 if(h.aplicado_at)add('p',`Aplicado: ${h.aplicado_at}`);
 if(h.referencia_bancaria)add('p',`Referencia bancaria: ${h.referencia_bancaria}`);
 if(detail.events?.length){add('h2','Historial de la solicitud');for(const event of detail.events)add('p',`${event.fecha} · ${event.accion.replaceAll('_',' ')} · ${event.user||'—'}${event.nota?` · ${event.nota}`:''}`);}
 await downloadDocumentPdf({root,scope:'payment-request',title:`Solicitud de pago ${h.numero}`,company:options.company,currency});
}
