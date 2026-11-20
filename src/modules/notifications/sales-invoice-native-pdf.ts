import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
import type {SalesInvoiceDocument,SalesInvoicePdfViewModel} from './sales-invoice-delivery.service.js';

// Only server-selected document fields become PDF text. No HTML, URLs or browser process.
export async function salesInvoiceNativePdf(invoice:SalesInvoiceDocument,model:SalesInvoicePdfViewModel):Promise<Buffer>{
 const doc=new PDFDocument({size:'A4',margin:40,bufferPages:true,info:{Title:`Factura ${invoice.number}`,Author:invoice.company.name,Creator:'GENTIA ERP'}});
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];doc.on('data',chunk=>chunks.push(chunk));doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  try{
   const font=(name:string)=>fileURLToPath(new URL(`../../../public/assets/pdfjs-6.5.438/standard_fonts/LiberationSans-${name}.ttf`,import.meta.url));
   doc.registerFont('Regular',font('Regular')).registerFont('Bold',font('Bold')).font('Regular');
   const left=40,width=doc.page.width-80,bottom=doc.page.height-64,navy='#163052',muted='#66788c';let y=40;
   const text=(value:unknown)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
   const money=(n:number)=>`${invoice.currency.symbol||invoice.currency.code} ${Number(n||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
   const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(String(s).slice(0,10))?new Date(s.slice(0,10)+'T12:00:00Z').toLocaleDateString('es-CR',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'}):'—';
   const write=(value:unknown,x:number,top:number,w:number,size=9,bold=false,align:'left'|'right'='left')=>{doc.font(bold?'Bold':'Regular').fontSize(size).fillColor(navy).text(text(value),x,top,{width:w,align,lineBreak:false});};
   const wrap=(value:unknown,w:number,size=9)=>{doc.font('Regular').fontSize(size);const lines:string[]=[];for(const paragraph of text(value).split('\n')){let line='';for(const word of paragraph.split(/\s+/)){if(!word)continue;if(doc.widthOfString(line+(line?' ':'')+word)<=w){line+=(line?' ':'')+word;continue;}if(line)lines.push(line);line='';for(const char of word){if(doc.widthOfString(line+char)>w&&line){lines.push(line);line='';}line+=char;}}lines.push(line);}return lines;};
   const block=(value:unknown,x:number,top:number,w:number,size=9,bold=false)=>{const lines=wrap(value,w,size);lines.forEach((line,i)=>write(line,x,top+i*(size+4),w,size,bold));return lines.length*(size+4);};
   let brandX=left;
   if(invoice.company.logo&&/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(invoice.company.logo)&&invoice.company.logo.length<2_000_000){
    try{const data=Buffer.from(invoice.company.logo.split(',')[1],'base64');const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(!png||(data.length>=24&&data.readUInt32BE(16)<=4096&&data.readUInt32BE(20)<=4096)){doc.image(data,left,y,{fit:[48,48]});brandX+=60;}}catch{/* An invalid optional logo cannot block the invoice. */}
   }
   const brandHeight=block(invoice.company.name,brandX,y,260-(brandX-left),17,true);const addressHeight=block(invoice.company.address,brandX,y+brandHeight+7,260-(brandX-left),9);
   write('FACTURA DE VENTA',left+width-230,y,230,10,true,'right');block(invoice.number,left+width-230,y+23,230,14,true);write('CONTABILIZADA',left+width-150,y+49,150,8,true,'right');
   y+=Math.max(80,brandHeight+addressHeight+20);doc.moveTo(left,y).lineTo(left+width,y).strokeColor('#078765').lineWidth(2).stroke();y+=22;
   write('FACTURAR A',left,y,260,8,true);y+=18;const customerY=y;
   const customer=[invoice.customer.name,invoice.customer.taxId?`Identificación fiscal: ${invoice.customer.taxId}`:'',invoice.customer.address,invoice.customer.email].filter(Boolean).join('\n');
   const customerHeight=block(customer,left,y,245,10);
   const facts=[['Emisión',date(invoice.issueDate)],['Vencimiento',date(invoice.dueDate)],['Términos de pago',invoice.paymentTerm||'—'],['Moneda',`${invoice.currency.code} · ${invoice.currency.name}`]];
   let factsY=y;for(const [label,value]of facts){write(label,left+width-240,factsY,90,8);factsY+=Math.max(19,block(value,left+width-145,factsY,145,8,true));}
   y=customerY+Math.max(customerHeight,factsY-customerY)+24;
   const unified=Boolean(invoice.unifyLinesPdf),widths=unified?[204,29,67,67,70,78]:[151,53,29,67,67,70,78];widths[0]+=width-widths.reduce((a,b)=>a+b,0);
   const headings=unified?['PRODUCTO / DESCRIPCIÓN','CANT','PRECIO UNIT.','SUBTOTAL','IMPUESTO','TOTAL']:['PRODUCTO / DESCRIPCIÓN','PAÍS','CANT','PRECIO UNIT.','SUBTOTAL','IMPUESTO','TOTAL'];
   const tableHeader=()=>{doc.rect(left,y,width,29).fill('#edf2f6');let x=left;headings.forEach((title,i)=>{write(title,x+5,y+10,widths[i]-10,6.5,true);x+=widths[i];});y+=29;};
   const newPage=(table=false)=>{doc.addPage();y=40;write(`Factura ${invoice.number}`,left,y,width,10,true);y+=30;if(table)tableHeader();};
   if(y+80>bottom)newPage();tableHeader();
   for(const line of model.lines){
    const values=[`${line.product}${line.description?'\n'+line.description:''}`,...(unified?[]:[line.serviceCountry]),Number(line.quantity).toLocaleString('es-CR',{maximumFractionDigits:6}),money(line.unitPrice),money(line.amount),`${money(line.taxAmount)}\n${line.taxCode||'Sin impuesto'} · ${line.taxRate}%`,money(line.grossAmount)];
    let cells=values.map((v,i)=>wrap(v,widths[i]-10,8));
    const rowHeight=Math.max(...cells.map(c=>c.length))*11+14;if(rowHeight<=bottom-110&&y+rowHeight>bottom)newPage(true);
    while(cells.some(c=>c.length)){
     if(y+36>bottom)newPage(true);const take=Math.max(1,Math.floor((bottom-y-14)/11)),count=Math.min(take,Math.max(...cells.map(c=>c.length))),height=count*11+14;let x=left;
     cells.forEach((lines,i)=>{lines.slice(0,count).forEach((value,j)=>write(value,x+5,y+7+j*11,widths[i]-10,8,i===values.length-1,i>=(unified?1:2)?'right':'left'));x+=widths[i];});
     y+=height;doc.moveTo(left,y).lineTo(left+width,y).lineWidth(.5).strokeColor('#dbe3ec').stroke();cells=cells.map(c=>c.slice(count));if(cells.some(c=>c.length))newPage(true);
    }
   }
   y+=24;
   const totals=[['Subtotal',money(model.subtotal)],['Impuestos',money(model.tax)],['Retenciones',money(invoice.withholdingTotal)],['TOTAL FACTURA',money(model.total)],['Saldo por cobrar',money(invoice.receivable)]];
   if(y+140>bottom)newPage();for(const [label,value]of totals){if(label==='TOTAL FACTURA')doc.rect(left+width-260,y-5,260,27).fill('#edf8f2');write(label,left+width-255,y,110,9,label==='TOTAL FACTURA');write(value,left+width-145,y,140,10,true,'right');y+=26;}
   if(invoice.memo){y+=16;if(y+35>bottom)newPage();write('NOTA',left,y,width,8,true);y+=18;for(const line of wrap(invoice.memo,width,9)){if(y+14>bottom)newPage();write(line,left,y,width,9);y+=13;}}
   const pages=doc.bufferedPageRange();for(let page=pages.start;page<pages.start+pages.count;page++){doc.switchToPage(page);doc.moveTo(left,bottom+3).lineTo(left+width,bottom+3).strokeColor('#dbe3ec').stroke();doc.fillColor(muted);write('Documento generado desde GENTIA ERP',left,bottom+12,width-85,7);write(`${page+1} / ${pages.count}`,left+width-75,bottom+12,75,7,false,'right');}
   doc.end();
  }catch(error){doc.destroy();reject(error);}
 });
}
