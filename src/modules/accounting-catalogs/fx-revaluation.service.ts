import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';
const functions:Record<string,string>={options:'fx_options',settings:'fx_save_settings',preview:'fx_prepare',execute:'fx_execute',cancel:'fx_cancel',report:'fx_report'};
export async function assertFxRevaluationAccess(auth:string,action:string,p:Record<string,unknown>={}){if(!/^Bearer\s+\S+$/i.test(auth))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});if(!functions[action])throw Object.assign(Error('Acción inválida.'),{status:400});const{assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');const choices:('view'|'create')[]=action==='options'||(action==='report'&&p.runId!==undefined)?['view','create']:action==='report'?['view']:['create'];for(const resource of action==='options'||action==='report'?['accounting:fx-revaluation','accounting:fx-revaluation-analysis']:['accounting:fx-revaluation'])for(const a of choices){if(resource.endsWith('-analysis')&&a==='create')continue;try{await assertRoleAccess(auth,resource,a);return;}catch(e){if((e as {status?:number}).status!==403)throw e;}}throw Object.assign(Error('El rol activo no puede realizar esta operación de revaluación.'),{status:403});}
const uncertainMessage='No fue posible confirmar la respuesta de la revaluación. Consulte el estado del proceso antes de volver a ejecutar.';
function failure(status:number,message:string){return Object.assign(Error(message),{status});}
function responseFailure(httpStatus:number,data:unknown){
 const code=data&&typeof data==='object'&&!Array.isArray(data)&&'code'in data?String(data.code):'';
 if(httpStatus===401)return failure(401,'La sesión no está disponible. Inicie sesión para consultar el estado del proceso.');
 if(httpStatus===403||code==='42501')return failure(403,'El rol activo no puede realizar esta operación.');
 if(code==='57014'||httpStatus===504)return failure(504,uncertainMessage);
 if(httpStatus===502||httpStatus===503||/^08/.test(code)||['PGRST000','PGRST001','PGRST002','PGRST003'].includes(code))return failure(httpStatus===502?502:503,uncertainMessage);
 if(['55000','P0001','23503','23505'].includes(code))return failure(409,'Revise la vista previa, saldos, cuentas y períodos de revaluación.');
 if(['22023','22P02','22003','22007','22008','23514'].includes(code))return failure(400,'Revise los campos y la tasa de cierre.');
 // A support reference identifies the failing boundary without exposing SQL,
 // table names, user input, tokens or database error details to the browser.
 const reference=/^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code)?` Referencia: FX-${code}.`:'';
 return failure(500,'No fue posible procesar la revaluación.'+reference);
}
export async function fxRevaluation(auth:string,action:string,p:Record<string,unknown>={}){
 await assertFxRevaluationAccess(auth,action,p);
 if(['execute','cancel'].includes(action)||(action==='report'&&p.runId!==undefined)){
  if(!Number.isSafeInteger(Number(p.runId))||Number(p.runId)<=0)throw failure(400,'Proceso inválido.');
 }
 const c=getSupabaseConfig();if(!c)throw Error('Supabase no está configurado.');
 let response:Response,raw:string;
 try{
  response=await fetchSupabase(new URL('/rest/v1/rpc/'+functions[action],c.url),{method:'POST',headers:{apikey:c.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(action==='options'?{}:{p_payload:p})});
  raw=await response.text();
 }catch{throw failure(503,uncertainMessage);}
 let data:unknown;
 try{data=raw?JSON.parse(raw):null;}catch{throw response.ok?failure(502,uncertainMessage):responseFailure(response.status,null);}
 if(!response.ok)throw responseFailure(response.status,data);
 if(!data||typeof data!=='object'||Array.isArray(data))throw failure(502,uncertainMessage);
 return data as Record<string,unknown>;
}
