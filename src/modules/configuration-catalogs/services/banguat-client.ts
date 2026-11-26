import {setTimeout as wait} from 'node:timers/promises';

const services=['https://www.banguat.gob.gt/variables/ws/TipoCambio.asmx','https://banguat.gob.gt/variables/ws/TipoCambio.asmx'];
type Dependencies={fetch?:typeof fetch;wait?:(ms:number)=>Promise<unknown>};
class BanguatError extends Error{constructor(message:string,readonly retryable:boolean){super(message);}}
function tag(xml:string,name:string){return xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([^<]*)</(?:[\\w-]+:)?${name}\\s*>`,'i'))?.[1].trim();}

export function parseBanguatRate(xml:string,date:string){
 const [year,month,day]=date.split('-'),requested=`${day}/${month}/${year}`;
 const records=xml.match(/<(?:[\w-]+:)?Var\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?Var\s*>/gi)||[];
 const record=records.find(row=>tag(row,'fecha')===requested&&tag(row,'moneda')==='2');
 if(!record)throw new BanguatError('El Banco de Guatemala no publicó una tasa para la fecha solicitada.',false);
 const compra=Number(tag(record,'compra')),venta=Number(tag(record,'venta'));
 if(!Number.isFinite(compra)||compra<=0||!Number.isFinite(venta)||venta<=0)throw new BanguatError('El Banco de Guatemala devolvió una tasa inválida.',false);
 return {tasaCompra:compra,tasaVenta:venta};
}

/** Both endpoints are official Banguat HTTPS hosts; certificate checks stay enabled. */
export async function consultarBanguat(date:string,dependencies:Dependencies={}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('La fecha efectiva no es válida.');
 const [year,month,day]=date.split('-'),requested=`${day}/${month}/${year}`;
 const body=`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><TipoCambioRango xmlns="http://www.banguat.gob.gt/variables/ws/"><fechainit>${requested}</fechainit><fechafin>${requested}</fechafin></TipoCambioRango></soap:Body></soap:Envelope>`;
 let detail='error de conexión';
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await(dependencies.fetch||fetch)(services[attempt%services.length]!,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'"http://www.banguat.gob.gt/variables/ws/TipoCambioRango"','User-Agent':'Gentia ERP/1.0'},body,signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw new BanguatError(`El servicio del Banco de Guatemala respondió con estado ${response.status}.`,[408,429,500,502,503,504,525].includes(response.status));
   return parseBanguatRate(await response.text(),date);
  }catch(cause){
   if(cause instanceof BanguatError){if(!cause.retryable)throw cause;detail=cause.message;}
   else{
    const error=cause as {name?:string;cause?:{code?:string}};
    const code=error?.cause?.code;
    detail=error?.name==='TimeoutError'?'tiempo de espera agotado':code&&/^[A-Z0-9_]{1,60}$/.test(code)?`error de conexión (${code})`:'error de conexión';
   }
   if(attempt<2)await(dependencies.wait||wait)(attempt===0?1000:3000);
  }
 }
 throw Error(`No fue posible consultar al Banco de Guatemala después de 3 intentos: ${detail}`);
}
