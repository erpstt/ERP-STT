import {createHmac,timingSafeEqual} from 'node:crypto';
import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {assertRoleAccess} from '../security-catalogs/role-access-matrix.module.js';

export type BankingCsvKind='CHECKS'|'DEPOSITS';
const common=['documento_referencia','fecha','cuenta_bancaria','moneda','tipo_cambio','referencia_bancaria','ubicacion','nota_documento','numero_cuenta','importe','nota_linea','tipo_entidad','identificacion_entidad','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada'];
export const bankingCsvHeaders={CHECKS:[common[0]!,'tipo_movimiento',...common.slice(1,6),'beneficiario',...common.slice(6)],DEPOSITS:[...common.slice(0,10),'metodo_pago',...common.slice(10)]};
const failure=(status:number,message:string)=>Object.assign(Error(message),{status});
export function bankingCsvKind(value:unknown):BankingCsvKind{if(value==='checks'||value==='CHECKS')return'CHECKS';if(value==='deposits'||value==='DEPOSITS')return'DEPOSITS';throw failure(400,'Seleccione cheques/transferencias o depósitos bancarios.');}
export function parseBankingCsv(source:string,kind:BankingCsvKind):Record<string,string>[] {
 if(typeof source!=='string'||Buffer.byteLength(source,'utf8')>2*1024*1024)throw failure(400,'El CSV admite hasta 2 MB.');
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source))throw failure(400,'El CSV contiene caracteres de control no admitidos.');
 const text=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),delimiter=text.split('\n')[0]!.includes(';')?';':',';
 const records:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 const finishField=()=>{row.push(field.trim());field='';closed=false;};
 const finishRow=()=>{finishField();if(row.some(Boolean))records.push(row);row=[];if(records.length>2001)throw failure(400,'El CSV admite hasta 2000 filas.');};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}
  else if(c===delimiter)finishField();else if(c==='\n')finishRow();else if(c==='"'&&!field&&!closed)quoted=true;
  else{if(closed||c==='"')throw failure(400,'CSV inválido: revise las comillas.');field+=c;}
  if(field.length>2048)throw failure(400,'Cada campo del CSV admite hasta 2048 caracteres.');
 }
 if(quoted)throw failure(400,'CSV inválido: hay comillas sin cerrar.');if(field||row.length||closed)finishRow();
 const headers=records.shift(),expected=bankingCsvHeaders[kind];
 if(!headers||new Set(headers).size!==headers.length||headers.length!==expected.length||headers.some(h=>!expected.includes(h)))throw failure(400,'Conserve las columnas de la plantilla: '+expected.join(';')+'.');
 if(!records.length)throw failure(400,'El CSV no contiene filas para validar.');
 return records.map((values,index)=>{if(values.length!==headers.length)throw failure(400,`Registro ${index+2}: cantidad de columnas incorrecta.`);return Object.fromEntries(headers.map((h,column)=>[h,values[column]!]));});
}
type CsvContext={userId:number;roleId:number;subsidiaryId:number;sessionId:string;revision?:string};
type PreviewProof={version:1;kind:BankingCsvKind;context:CsvContext;fingerprint:string;validationDigest:string;expiresAt:number};
function proofKey(){const key=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();if(!key)throw failure(503,'La validación segura de importaciones no está configurada.');return createHmac('sha256',key).update('gentia/banking-csv-preview/v1').digest();}
function proofSignature(value:string){return createHmac('sha256',proofKey()).update(value).digest();}
function signProof(value:PreviewProof){const text=Buffer.from(JSON.stringify(value)).toString('base64url');return text+'.'+proofSignature(text).toString('base64url');}
function readProof(token:unknown,kind:BankingCsvKind,subsidiaryId:number){
 if(typeof token!=='string'||token.length>4096)throw failure(409,'Valide el archivo antes de importarlo.');
 const parts=token.split('.');if(parts.length!==2||!parts.every(p=>/^[a-zA-Z0-9_-]+$/.test(p)))throw failure(409,'La validación del archivo no es válida. Vuelva a validar.');
 const expected=proofSignature(parts[0]!),actual=Buffer.from(parts[1]!,'base64url');
 if(actual.length!==expected.length||actual.toString('base64url')!==parts[1]||!timingSafeEqual(expected,actual))throw failure(409,'La validación del archivo no es válida. Vuelva a validar.');
 let value:PreviewProof;try{value=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));}catch{throw failure(409,'Vuelva a validar el archivo.');}
 if(value.version!==1||value.kind!==kind||value.context?.subsidiaryId!==subsidiaryId||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||!/^[0-9a-f]{64}$/.test(value.fingerprint)||!/^[0-9a-f]{64}$/.test(value.validationDigest))throw failure(409,'El contexto o la vigencia de la validación cambió. Vuelva a validar.');
 return value;
}
async function rpc(auth:string,name:string,payload:Record<string,unknown>){
 const c=getSupabaseConfig();if(!c)throw failure(503,'No fue posible conectar con el servicio de importación.');
 let response:Response;
 try{response=await fetchSupabase(new URL('/rest/v1/rpc/'+name,c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload)});}
 catch{throw failure(503,'No fue posible conectar con el servicio de importación. Si confirmó el archivo, vuelva a validarlo para consultar su comprobante.');}
 if(response.status===429)throw failure(429,'El servicio está ocupado. Espere antes de consultar nuevamente.');
 if(response.status===408||response.status>=500)throw failure(503,'No fue posible confirmar la respuesta del servicio. Vuelva a validar el mismo archivo antes de intentar otra importación.');
 let value:Record<string,unknown>;try{value=await response.json() as Record<string,unknown>;}catch{throw failure(503,'El servicio de importación no devolvió una respuesta válida.');}
 if(!response.ok){const code=String(value?.code??'');if(response.status===401)throw failure(401,'La sesión no es válida.');if(response.status===403||code==='42501')throw failure(403,'No tiene permiso para importar estos movimientos en la empresa activa.');if(['55000','PT409','23505'].includes(code))throw failure(409,'La validación, el contexto o las referencias cambiaron. Vuelva a validar el archivo.');if(['22023','22P02','22007','22008'].includes(code))throw failure(400,'Revise el formato del archivo CSV.');throw failure(503,'No fue posible procesar la importación bancaria.');}
 if(!value||typeof value!=='object'||typeof value.valid!=='boolean'||!Array.isArray(value.entries)||!Array.isArray(value.errors))throw failure(503,'El servicio de importación no devolvió una respuesta válida.');return value;
}
async function inputRows(auth:string,rawKind:unknown,input:Record<string,unknown>){
 if(!/^Bearer\s+\S+$/i.test(auth))throw failure(401,'Debe iniciar sesión.');
 const kind=bankingCsvKind(rawKind);await assertRoleAccess(auth,kind==='CHECKS'?'banking:bank-checks':'banking:bank-deposits','create');
 if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.csv!=='string'||!Number.isSafeInteger(input.subsidiaryId)||Number(input.subsidiaryId)<=0)throw failure(400,'Seleccione un CSV y una empresa válida.');
 return{kind,rows:parseBankingCsv(input.csv,kind),sid:Number(input.subsidiaryId)};
}
export async function previewBankingCsv(auth:string,rawKind:unknown,input:Record<string,unknown>){
 const{kind,rows,sid}=await inputRows(auth,rawKind,input);proofKey();
 const result=await rpc(auth,'banking_csv_preview',{p_kind:kind,p_rows:rows,p_subsidiary_id:sid});
 if(result.valid===true&&result.alreadyImported!==true){
  const context=result.context as CsvContext;
  if(!context||context.subsidiaryId!==sid||!Number.isSafeInteger(context.userId)||!Number.isSafeInteger(context.roleId)||typeof context.sessionId!=='string'||!/^[0-9a-f]{64}$/.test(String(result.fingerprint))||!/^[0-9a-f]{64}$/.test(String(result.validationDigest)))throw failure(503,'No fue posible vincular la validación al contexto actual.');
  const expiresAt=Date.now()+15*60*1000;
  return{...result,previewToken:signProof({version:1,kind,context,fingerprint:String(result.fingerprint),validationDigest:String(result.validationDigest),expiresAt}),expiresAt:new Date(expiresAt).toISOString()};
 }return result;
}
export async function importBankingCsv(auth:string,rawKind:unknown,input:Record<string,unknown>){
 const{kind,rows,sid}=await inputRows(auth,rawKind,input),proof=readProof(input.previewToken,kind,sid);
 return rpc(auth,'banking_csv_import',{p_kind:kind,p_rows:rows,p_subsidiary_id:sid,p_expected_context:proof.context,p_fingerprint:proof.fingerprint,p_validation_digest:proof.validationDigest});
}
