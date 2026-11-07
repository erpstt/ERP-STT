import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertJournalAccess } from './journal-entry.service.js';

export const journalCsvOptionalHeaders = ['pais_servicio','entidad','nombre','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada'];
export const journalCsvHeaders = ['asiento_referencia','tipo_asiento','fecha','moneda','nota_asiento','numero_cuenta','debito','credito','nota_linea','mes_servicio', ...journalCsvOptionalHeaders];
const automaticServiceDimensionJournalTypes = new Set(['ASI_DIA','ASI_NOM','ASI_LIQ']);

// Quoted fields may contain delimiters, escaped quotes and line breaks (RFC 4180).
export function parseJournalCsv(source: string): Record<string, string>[] {
  if (Buffer.byteLength(source, 'utf8') > 2 * 1024 * 1024) throw Error('El CSV supera el límite de 2 MB.');
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = text.split('\n')[0].includes(';') ? ';' : ',';
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const finishField = () => { row.push(field.trim()); field = ''; closed = false; };
  const finishRow = () => { finishField(); if (row.some(Boolean)) records.push(row); row = []; if (records.length > 2001) throw Error('El CSV admite hasta 2000 líneas contables.'); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === delimiter) finishField();
    else if (char === '\n') finishRow();
    else if (char === '"' && !field && !closed) quoted = true;
    else { if (closed || char === '"') throw Error('CSV inválido: revise las comillas.'); field += char; }
  }
  if (quoted) throw Error('CSV inválido: hay comillas sin cerrar.');
  if (field || row.length || closed) finishRow();
  const headers = records.shift();
  if (!headers || new Set(headers).size !== headers.length || headers.some(key => key !== 'tipo_cambio' && !journalCsvHeaders.includes(key)) || journalCsvHeaders.filter(key => !journalCsvOptionalHeaders.includes(key)).some(key => !headers.includes(key))) throw Error(`Conserve las columnas de la plantilla: ${journalCsvHeaders.join(', ')}.`);
  if (!records.length) throw Error('El CSV no contiene líneas contables.');
  return records.map((values, index) => {
    if (values.length !== headers.length) throw Error(`Registro ${index + 2}: cantidad de columnas incorrecta.`);
    // Omit empty optional fields to preserve receipts for previously imported files.
    return Object.fromEntries(headers.map((key, column) => [key, values[column]]).filter(([key, value]) => key !== 'tipo_cambio' && (value !== '' || !journalCsvOptionalHeaders.includes(key))));
  });
}

export function normalizeJournalServiceDimensions(rows: Record<string, string>[]) {
  return rows.map(row => {
    if (!automaticServiceDimensionJournalTypes.has(row.tipo_asiento)) return row;
    const normalized: Record<string, string> = { ...row, mes_servicio: '' };
    delete normalized.pais_servicio;
    return normalized;
  });
}

// Compatibility for consumers introduced with the automatic service-month
// rule. Both service-only fields are now normalized together.
export function normalizeJournalServiceMonths(rows: Record<string, string>[]) {
  return normalizeJournalServiceDimensions(rows);
}

type JournalCsvContext={userId:number;roleId:number;subsidiaryId:number;sessionId:string;revision?:string};
type JournalCsvProof={version:1;kind:'JOURNALS';context:JournalCsvContext;fingerprint:string;validationDigest:string;expiresAt:number};
const failure=(status:number,message:string)=>Object.assign(Error(message),{status});
function proofKey(){
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if(!key)throw failure(503,'La validación segura de importaciones no está configurada.');
  return createHmac('sha256',key).update('gentia/journal-csv-preview/v1').digest();
}
function signature(value:string){return createHmac('sha256',proofKey()).update(value).digest();}
function signProof(value:JournalCsvProof){const encoded=Buffer.from(JSON.stringify(value)).toString('base64url');return encoded+'.'+signature(encoded).toString('base64url');}
function validContext(value:unknown,sid:number):value is JournalCsvContext{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const context=value as JournalCsvContext;
  return context.subsidiaryId===sid&&Number.isSafeInteger(context.userId)&&context.userId>0&&Number.isSafeInteger(context.roleId)&&context.roleId>0&&typeof context.sessionId==='string'&&context.sessionId.length>0&&context.sessionId.length<=256&&(context.revision===undefined||typeof context.revision==='string');
}
function readProof(token:unknown,sid:number):JournalCsvProof{
  if(typeof token!=='string'||token.length>4096)throw failure(409,'Valide el archivo antes de importarlo.');
  const parts=token.split('.');
  if(parts.length!==2||!parts.every(part=>/^[a-zA-Z0-9_-]+$/.test(part)))throw failure(409,'Vuelva a validar el archivo.');
  const expected=signature(parts[0]!),actual=Buffer.from(parts[1]!,'base64url');
  if(actual.length!==expected.length||actual.toString('base64url')!==parts[1]||!timingSafeEqual(actual,expected))throw failure(409,'La validación del archivo no es válida. Vuelva a validar.');
  let value:JournalCsvProof;try{value=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));}catch{throw failure(409,'Vuelva a validar el archivo.');}
  if(!value||value.version!==1||value.kind!=='JOURNALS'||!validContext(value.context,sid)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||!/^[0-9a-f]{64}$/.test(value.fingerprint)||!/^[0-9a-f]{64}$/.test(value.validationDigest))throw failure(409,'El contexto o la vigencia de la validación cambió. Vuelva a validar.');
  return value;
}
async function journalCsvRpc(authorization:string,name:string,payload:Record<string,unknown>){
  const config=getSupabaseConfig();if(!config)throw failure(503,'No fue posible conectar con el servicio de importación.');
  let response:Response;
  try{response=await fetchSupabase(new URL('/rest/v1/rpc/'+name,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(payload)});}
  catch{throw failure(503,'No fue posible confirmar la respuesta del servicio. Vuelva a validar el mismo archivo antes de intentar otra importación.');}
  if(response.status===429)throw failure(429,'El servicio está ocupado. Espere antes de consultar nuevamente.');
  if(response.status===408||response.status>=500)throw failure(503,'No fue posible confirmar la respuesta del servicio. Vuelva a validar el mismo archivo antes de intentar otra importación.');
  let result:Record<string,unknown>;try{result=await response.json() as Record<string,unknown>;}catch{throw failure(503,'El servicio de importación no devolvió una respuesta válida.');}
  if(!response.ok){
    const code=String(result?.code??'');
    if(response.status===401)throw failure(401,'La sesión no es válida.');
    if(response.status===403||code==='42501')throw failure(403,'No tiene permiso para realizar esta operación contable.');
    if(['55000','PT409','23505'].includes(code))throw failure(409,'La validación, el contexto o las referencias cambiaron. Vuelva a validar el archivo.');
    if(['22023','22P02','22007','22008','P0001'].includes(code))throw failure(400,'Revise los datos y el formato del archivo CSV.');
    throw failure(503,'No fue posible procesar la importación contable.');
  }
  if(!result||typeof result!=='object'||typeof result.valid!=='boolean'||!Array.isArray(result.entries)||!Array.isArray(result.errors))throw failure(503,'El servicio de importación no devolvió una respuesta válida.');
  return result;
}
export async function importJournalCsv(authorization:string,input:Record<string,unknown>){
  await assertJournalAccess(authorization,input?.preview===true?'view':'create');
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.csv!=='string'||typeof input.preview!=='boolean'||!Number.isSafeInteger(input.subsidiaryId)||Number(input.subsidiaryId)<=0)throw failure(400,'Seleccione un CSV y una subsidiaria válida.');
  const sid=Number(input.subsidiaryId);let rows:Record<string,string>[];
  try{rows=normalizeJournalServiceDimensions(parseJournalCsv(input.csv));}catch(error){throw failure(400,error instanceof Error?error.message:'Revise el archivo CSV.');}
  if(!input.preview){
    const proof=readProof(input.previewToken,sid);
    return journalCsvRpc(authorization,'journal_csv_import',{p_rows:rows,p_subsidiary_id:sid,p_expected_context:proof.context,p_fingerprint:proof.fingerprint,p_validation_digest:proof.validationDigest});
  }
  proofKey();
  const result=await journalCsvRpc(authorization,'journal_csv_preview',{p_rows:rows,p_subsidiary_id:sid});
  if(result.valid===true&&result.alreadyImported!==true){
    if(!validContext(result.context,sid)||!/^[0-9a-f]{64}$/.test(String(result.fingerprint))||!/^[0-9a-f]{64}$/.test(String(result.validationDigest)))throw failure(503,'No fue posible vincular la validación al contexto actual.');
    const expiresAt=Date.now()+15*60*1000;
    return{...result,previewToken:signProof({version:1,kind:'JOURNALS',context:result.context,fingerprint:String(result.fingerprint),validationDigest:String(result.validationDigest),expiresAt}),expiresAt:new Date(expiresAt).toISOString()};
  }
  return result;
}
