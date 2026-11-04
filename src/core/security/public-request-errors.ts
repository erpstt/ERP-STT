export type PublicFailureStatus=400|500;
export type PublicFailureMethod='GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE'|'OPTIONS'|'OTHER';
export type PublicFailureFamily='AUTH'|'SECURITY'|'REPORTS'|'OPENING_BALANCES'|'API'|'OTHER';
export type PublicFailureType='TYPE_ERROR'|'RANGE_ERROR'|'SYNTAX_ERROR'|'REFERENCE_ERROR'|'URI_ERROR'|'EVAL_ERROR'|'ERROR'|'NON_ERROR';

const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function matches(target:string,prefix:string){return target===prefix||target.startsWith(prefix+'/')||target.startsWith(prefix+'?');}
function family(target:string):PublicFailureFamily{
 if(matches(target,'/api/auth'))return'AUTH';
 if(matches(target,'/api/security'))return'SECURITY';
 if(matches(target,'/api/reports')||matches(target,'/api/v1/reports'))return'REPORTS';
 if(matches(target,'/api/opening-balances'))return'OPENING_BALANCES';
 return matches(target,'/api')?'API':'OTHER';
}
function errorType(cause:unknown):PublicFailureType{
 // Never read name, message, stack, code, toString or other error properties.
 try{
  if(cause instanceof TypeError)return'TYPE_ERROR';
  if(cause instanceof RangeError)return'RANGE_ERROR';
  if(cause instanceof SyntaxError)return'SYNTAX_ERROR';
  if(cause instanceof ReferenceError)return'REFERENCE_ERROR';
  if(cause instanceof URIError)return'URI_ERROR';
  if(cause instanceof EvalError)return'EVAL_ERROR';
  if(cause instanceof Error)return'ERROR';
 }catch{/* Hostile thrown proxies cannot become log metadata. */}
 return'NON_ERROR';
}

/** Pure mapping for the two unknown-request fallbacks only (partial M03).
 * The caller supplies its own server-generated UUID, never a client header.
 * Return only public constants and closed-enum log fields; perform no IO.
 */
export function publicRequestError(cause:unknown,context:{requestId:string;status:PublicFailureStatus;method?:string;target?:string}){
 if(typeof context.requestId!=='string'||!uuid.test(context.requestId))throw new RangeError('Referencia de solicitud inválida.');
 if(context.status!==400&&context.status!==500)throw new RangeError('Estado de error público inválido.');
 const target=typeof context.target==='string'?context.target:'';
 const method:PublicFailureMethod=typeof context.method==='string'&&methods.has(context.method)?context.method as PublicFailureMethod:'OTHER';
 let message='No fue posible procesar la solicitud. Inténtalo de nuevo o consulta la referencia.';
 if(method==='POST'&&(target==='/api/auth/login'||target.startsWith('/api/auth/login?')))message='No fue posible iniciar sesión. Revisa tus datos o inténtalo más tarde.';
 if(method==='POST'&&(target==='/api/opening-balances/validate'||target.startsWith('/api/opening-balances/validate?')))message='No fue posible validar el archivo. Revisa el formato o consulta la referencia.';
 return{
  requestId:context.requestId,
  payload:{error:{message,status:context.status,requestId:context.requestId}},
  log:{id:context.requestId,status:context.status,method,family:family(target),errorType:errorType(cause)}
 };
}
