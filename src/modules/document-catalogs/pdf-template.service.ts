import {assertRoleAccess,myRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

const rpcNames:Record<string,string>={options:'pdf_template_options',save:'pdf_template_save',clone:'pdf_template_clone',delete:'pdf_template_delete',get:'pdf_template_compiled'};
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const allowedTypes=new Set(['text','image','divider','spacer','columns','items_table','totals','qr','signature','fiscal']);
const cleanColor=(v:unknown)=>/^#[0-9a-f]{3,8}$/i.test(String(v))?String(v):'';
const size=(v:unknown,min:number,max:number,fallback:number)=>Math.min(max,Math.max(min,Number(v)||fallback));

function invalidTemplate(message:string):never{throw Object.assign(Error(message),{status:400});}
export function validatePdfSchema(schema:unknown){
 if(!schema||typeof schema!=='object'||Array.isArray(schema))invalidTemplate('El diseño visual no es válido.');
 let serialized:string;try{serialized=JSON.stringify(schema);}catch{return invalidTemplate('El diseño visual no es válido.');}
 if(serialized.length>128000)invalidTemplate('El diseño visual supera el límite permitido.');
 let nodes=0;
 const visit=(value:unknown,depth:number)=>{if(depth>16||++nodes>4000)invalidTemplate('El diseño visual es demasiado complejo.');if(value&&typeof value==='object')for(const child of Object.values(value))visit(child,depth+1);};visit(schema,0);
}

const documentResources:Record<string,string>={FAC_VEN:'sales:invoices',NC_VEN:'sales:credit-notes',ND_VEN:'sales:debit-notes',ORD_COM:'purchasing:orders',PED_VEN:'sales:sales-orders',COT_VEN:'sales:quotations',SOL_PAG:'treasury:payment-requests',REC_PAG:'sales:customer-payments',ASI_DIA:'accounting:journals'};
export async function requirePdfTemplateAccess(auth:string,action:string,p:Record<string,unknown>={}){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 if(!['options','get','render','save','clone','delete'].includes(action))invalidTemplate('Acción de plantilla inválida.');
 const hasId=p.id!==undefined&&p.id!==null&&p.id!=='';
 if((['get','clone','delete'].includes(action)||hasId)&&(!Number.isSafeInteger(Number(p.id))||Number(p.id)<=0))invalidTemplate('La plantilla indicada no es válida.');
 const permission=action==='save'?(hasId?'edit':'create'):action==='clone'?'create':action==='delete'?'delete':'view';
 await assertRoleAccess(auth,'documents:pdf-templates',permission);
 if(action==='render'&&String(p.documentNumber||'').trim()){
  const resource=documentResources[String(p.documentType)];if(!resource)invalidTemplate('Tipo de documento no soportado.');
  await assertRoleAccess(auth,resource,'view');
 }
}

function componentHtml(raw:unknown):string{
 const c=(raw&&typeof raw==='object'?raw:{})as Record<string,unknown>,type=String(c.type||'text');if(!allowedTypes.has(type))return'';
 const st=(c.style&&typeof c.style==='object'?c.style:{})as Record<string,unknown>;
 const style=`font-size:${size(st.fontSize,7,48,11)}pt;color:${cleanColor(st.color)||'#172033'};background:${cleanColor(st.background)||'transparent'};text-align:${['left','center','right'].includes(String(st.align))?st.align:'left'};font-weight:${Number(st.fontWeight)>=600?700:400};padding:${size(st.padding,0,30,4)}px;margin:${size(st.margin,0,30,2)}px;border:${st.border?'1px solid #d6dee8':'0'}`;
 if(type==='divider')return'<hr class="block-divider">';if(type==='spacer')return`<div style="height:${size(c.height,4,100,18)}px"></div>`;
 if(type==='image')return`<div style="${style}"><img class="dynamic-image" src="${esc(c.binding||'{{company.logo_url}}')}" alt="Logo"></div>`;
 if(type==='items_table')return'<table class="items"><thead><tr>'+((Array.isArray(c.columns)?c.columns:['description','quantity','unit_price','subtotal'])as unknown[]).map(x=>`<th>${esc(String(x).replaceAll('_',' '))}</th>`).join('')+'</tr></thead><tbody>{{items.rows}}</tbody></table>';
 if(type==='totals')return'<section class="totals"><div>Subtotal <b>{{totals.subtotal}}</b></div><div>Descuentos <b>{{totals.discount_total}}</b></div><div>Impuestos <b>{{totals.tax_total}}</b></div><div class="grand">Total <b>{{totals.grand_total}}</b></div><small>{{totals.amount_in_words}}</small></section>';
 if(type==='qr')return'<div class="qr">▦<small>{{fiscal.electronic_key}}</small></div>';
 if(type==='signature')return'<div class="signature"><span>Firma autorizada</span><span>Recibido por</span></div>';
 if(type==='fiscal')return`<div class="fiscal" style="${style}">${esc(c.content||'Clave: {{fiscal.electronic_key}} · Consecutivo: {{document.number}}')}</div>`;
 if(type==='columns'){const children=Array.isArray(c.children)?c.children:[];return`<div class="columns">${children.map(componentHtml).join('')}</div>`}
 return`<div class="text-block" style="${style}">${esc(c.content||'Texto')}</div>`;
}
export function compilePdfTemplate(schema:unknown,pageSize='A4',orientation='PORTRAIT'){
 validatePdfSchema(schema);

 const s=(schema&&typeof schema==='object'?schema:{})as Record<string,unknown>,zones=(s.zones&&typeof s.zones==='object'?s.zones:{})as Record<string,unknown>,m=(s.margins&&typeof s.margins==='object'?s.margins:{})as Record<string,unknown>;
 const zone=(name:string)=>((Array.isArray(zones[name])?zones[name]:[])as unknown[]).map(componentHtml).join('');
 const dims=pageSize==='LETTER'?'216mm 279mm':pageSize==='THERMAL_80'?'80mm auto':'210mm 297mm';
 return`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${dims} ${orientation==='LANDSCAPE'?'landscape':'portrait'};margin:${size(m.top,0,40,12)}mm ${size(m.right,0,40,12)}mm ${size(m.bottom,0,40,12)}mm ${size(m.left,0,40,12)}mm}*{box-sizing:border-box}body{font:11pt Arial;color:#172033;margin:0}.page-header{border-bottom:2px solid #17845f;padding-bottom:7px}.page-footer{border-top:1px solid #ccd5df;padding-top:7px;font-size:8pt}.items{width:100%;border-collapse:collapse;margin:14px 0}.items th,.items td{padding:7px;border-bottom:1px solid #dce3eb;text-align:left}.items th{background:#eef4f1;text-transform:capitalize}.totals{width:310px;margin-left:auto}.totals div{display:flex;justify-content:space-between;padding:5px}.totals .grand{border-top:2px solid #16855f;font-size:14pt}.dynamic-image{max-width:160px;max-height:75px}.signature{display:flex;justify-content:space-between;margin-top:55px}.signature span{width:42%;border-top:1px solid;padding-top:6px;text-align:center}.qr{font-size:48px;text-align:center}.qr small{font-size:7pt;display:block}.columns{display:flex;gap:10px}.columns>*{flex:1}@media print{.page-header{position:running(header)}.page-footer{position:running(footer)}tr{break-inside:avoid}.totals{break-inside:avoid}}</style></head><body><header class="page-header">${zone('header')}</header><main>${zone('body')}</main><footer class="page-footer">${zone('footer')}</footer></body></html>`;
}
const mock=(number='FAC-001045')=>({company:{name:'S.T.T. HOLDINGS LIMITED',tax_id:'3-101-123456',logo_url:'',address:'San José, Costa Rica',phone:'+506 2200-0000',email:'facturacion@empresa.com',economic_activity:'Servicios profesionales'},entity:{name:'Cliente de ejemplo S.A.',tax_id:'3-101-654321',address:'San José',phone:'+506 8888-0000',email:'cliente@ejemplo.com',credit_days:'30'},document:{title:'Documento comercial',number,issue_date:'10/09/2026',due_date:'10/10/2026',currency_symbol:'$',seller_name:'Usuario GENTIA',payment_method:'Crédito'},totals:{subtotal:'1 000,00',discount_total:'0,00',tax_total:'130,00',grand_total:'1 130,00',amount_in_words:'Mil ciento treinta con 00/100'},fiscal:{electronic_key:'50610092600310112345600100001010000001045100000001',qr_code:''},items:[{code:'SERV-001',description:'Servicio profesional',quantity:'1',unit_price:'1 000,00',discount:'0,00',tax_rate:'13%',subtotal:'1 000,00'}]});
function render(compiled:string,data:Record<string,unknown>){let html=compiled;const flat:Record<string,unknown>={};for(const[k,v]of Object.entries(data))if(v&&typeof v==='object'&&!Array.isArray(v))for(const[a,b]of Object.entries(v))flat[`${k}.${a}`]=b;for(const[k,v]of Object.entries(flat))html=html.replaceAll(`{{${k}}}`,esc(v));const cols=['code','description','quantity','unit_price','discount','tax_rate','subtotal'],items=Array.isArray(data.items)?data.items as Array<Record<string,unknown>>:[];html=html.replace('{{items.rows}}',items.map(i=>`<tr>${cols.map(k=>`<td>${esc(i[k]??'')}</td>`).join('')}</tr>`).join(''));return html.replace(/\{\{[\w.]+\}\}/g,'');}
async function rpc(auth:string,name:string,params:Record<string,unknown>={}){const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');const r=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(params)}),raw=await r.text(),out=raw?JSON.parse(raw):null;if(!r.ok){const status=r.status===401?401:r.status===403||out?.code==='42501'?403:['23505','55000'].includes(out?.code)?409:['22023','22P02','23502','P0001'].includes(out?.code)?400:500;throw Object.assign(Error(status===403?'El rol activo no puede realizar esta acción sobre plantillas.':status===400?'Revise los datos del diseño y de la plantilla.':status===409?'La plantilla tiene una restricción o un conflicto.':'No fue posible procesar la plantilla.'),{status});}return out}
export async function pdfTemplates(auth:string,action:string,p:Record<string,unknown>={}){
 await requirePdfTemplateAccess(auth,action,p);
 if(action==='save'){
  validatePdfSchema(p.schema??{});
  const schema=structuredClone(p.schema??{}) as Record<string,unknown>;
  const zones=(schema.zones??{}) as Record<string,unknown>;schema.zones=zones;
  if(p.documentType==='FAC_VEN'){
   const footer=Array.isArray(zones.footer)?zones.footer:[];
   if(!footer.some(x=>x&&typeof x==='object'&&(x as Record<string,unknown>).type==='fiscal'))footer.push({id:`fiscal-${Date.now()}`,type:'fiscal',content:'Clave: {{fiscal.electronic_key}} · Consecutivo: {{document.number}}',locked:true});zones.footer=footer;
  }
  compilePdfTemplate(schema,String(p.pageSize||'A4'),String(p.orientation||'PORTRAIT'));
  // The visual schema is authoritative; neither client HTML nor an old HTML cache is trusted.
  const {compiled:_compiled,html_compiled:_html,...metadata}=p;
  return rpc(auth,rpcNames.save!,{p:{...metadata,schema,compiled:''}});
 }
 if(action==='render'){
  const compiled=compilePdfTemplate(p.schema??{},String(p.pageSize||'A4'),String(p.orientation||'PORTRAIT'));
  const number=String(p.documentNumber||'').trim(),data=number?await rpc(auth,'pdf_template_document_data',{p_type:String(p.documentType),p_number:number}):mock();
  return{html:render(compiled,data as Record<string,unknown>)};
 }
 const result=await rpc(auth,rpcNames[action]!,['clone','delete','get'].includes(action)?{p_id:Number(p.id)}:{});
 if(action==='get'){
  if(!result)throw Object.assign(Error('Plantilla no disponible.'),{status:404});
  return{...result,compiled:compilePdfTemplate(result.schema??{},String(result.pageSize||'A4'),String(result.orientation||'PORTRAIT'))};
 }
 if(action==='options'){
  const access=await myRoleAccess(auth),grant=access.grants.find(g=>g.resourceKey==='documents:pdf-templates');
  return{...result,access:{canView:true,canCreate:access.isAdmin||grant?.canCreate===true,canEdit:access.isAdmin||grant?.canEdit===true,canDelete:access.isAdmin||grant?.canDelete===true}};
 }
 return result;
}
