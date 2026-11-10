import {collectCatalogPages,type CatalogResponseObserver} from '../../core/database/collect-catalog-pages.js';
import{ fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';type T='text'|'number'|'boolean'|'date'|'datetime-local';export interface AiField{key:string;label:string;type:T;required?:boolean;reference?:string;}export interface AiCatalog{slug:string;table:string;title:string;description:string;primaryKey:string;fields:AiField[];}
export const aiCatalogs:AiCatalog[]=[
{slug:'ai-agents',table:'ai_agents',title:'Agentes de IA',description:'Agentes de IA del ERP',primaryKey:'agent_id',fields:[{key:'agent_name',label:'Agente',type:'text',required:true},{key:'system_prompt',label:'Prompt del sistema',type:'text',required:true},{key:'model_version',label:'Versión del modelo',type:'text',required:true},{key:'is_active',label:'Activo',type:'boolean'}]},
{slug:'ai-prompts',table:'ai_prompt',title:'Plantillas de prompts',description:'Plantillas de prompts de IA',primaryKey:'prompt_id',fields:[{key:'agent_id',label:'Agente',type:'number',required:true,reference:'ai/ai-agents'},{key:'prompt_name',label:'Plantilla',type:'text',required:true},{key:'prompt_text',label:'Prompt',type:'text',required:true},{key:'module_target',label:'Módulo objetivo',type:'text',required:true}]},
{slug:'ai-conversations',table:'ai_conversation',title:'Conversaciones de IA',description:'Conversaciones de usuarios con IA',primaryKey:'conversation_id',fields:[{key:'user_id',label:'Usuario',type:'number',reference:'security/users'},{key:'agent_id',label:'Agente',type:'number',required:true,reference:'ai/ai-agents'},{key:'started_at',label:'Fecha de inicio',type:'datetime-local',required:true}]},
{slug:'ai-documents',table:'ai_document',title:'Documentos procesados',description:'Procesamiento de documentos con OCR e IA',primaryKey:'ai_doc_id',fields:[{key:'document_id',label:'Documento',type:'number',required:true,reference:'documents/documents'},{key:'extracted_data_json',label:'Datos extraídos',type:'text',required:true},{key:'confidence_score',label:'Confianza (%)',type:'number',required:true}]},
{slug:'ai-predictions',table:'ai_prediction',title:'Predicciones',description:'Predicciones financieras y de demanda',primaryKey:'prediction_id',fields:[{key:'subsidiary_id',label:'Subsidiaria',type:'number',required:true,reference:'organization/subsidiaries'},{key:'prediction_type',label:'Tipo de predicción',type:'text',required:true},{key:'target_entity_id',label:'ID de entidad objetivo',type:'number',required:true},{key:'value_predicted',label:'Valor previsto',type:'number',required:true},{key:'confidence',label:'Confianza (%)',type:'number',required:true},{key:'execution_date',label:'Fecha de ejecución',type:'date',required:true}]}
];
export function getAiCatalog(s:string){const c=aiCatalogs.find(x=>x.slug===s);if(!c)throw new Error('El catálogo de IA no existe.');return c;}
type Action='view'|'create'|'edit'|'delete';
async function requireAiAccess(c:AiCatalog,t:string,action:Action){
 if(!/^Bearer\s+\S+$/i.test(t||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 const catalog=aiCatalogs.find(item=>item.slug===c?.slug);
 if(!catalog)throw Object.assign(Error('Catálogo de IA no válido.'),{status:400});
 // The access matrix imports these catalogs; resolve its guard after module initialization.
 const {assertRoleAccess}=await import('../security-catalogs/role-access-matrix.module.js');
 try{
  await assertRoleAccess(t,'ai:'+catalog.slug,'view');
  if(action!=='view')await assertRoleAccess(t,'ai:'+catalog.slug,action);
 }catch(error){
  const status=error&&typeof error==='object'&&'status'in error?Number(error.status):500;
  aiDbError(status,null);
 }
 return catalog;
}
function sanitize(c:AiCatalog,i:Record<string,unknown>){const d=Object.fromEntries(c.fields.filter(f=>c.slug!=='ai-conversations'||f.key!=='user_id').map(f=>{const r=i[f.key];if(f.required&&(r===undefined||r===null||String(r).trim()===''))throw new Error(`${f.label} es obligatorio.`);if(f.type==='boolean')return[f.key,Boolean(r)];if(f.type==='number')return[f.key,r===undefined||r===null||r===''?null:Number(r)];return[f.key,r===undefined||r===null||String(r).trim()===''?null:String(r).trim()];}));for(const key of['confidence_score','confidence'])if(d[key]!==undefined&&d[key]!==null&&(Number(d[key])<0||Number(d[key])>100))throw new Error('La confianza debe estar entre 0 y 100.');return d;}
function aiDbError(status:number,payload:unknown):never{
 const code=payload&&typeof payload==='object'&&'code'in payload?String(payload.code):'';
 const denied=status===403||code==='42501';
 const responseStatus=status===401?401:denied?403:['22023','22P02','23502','23503','23505','23514','P0001'].includes(code)?400:500;
 const message=responseStatus===401?'Debe iniciar sesión.':denied?'El rol activo no tiene acceso al catálogo de IA o a sus registros.':responseStatus===400?'Los datos del catálogo de IA no son válidos.':'No fue posible completar la operación de IA.';
 throw Object.assign(Error(message),{status:responseStatus});
}
async function request<R>(c:AiCatalog,t:string,q='',i:RequestInit={},onResponse?:CatalogResponseObserver):Promise<R>{
 const g=getSupabaseConfig();if(!g)throw new Error('Supabase no está configurado.');
 const r=await fetchSupabase(new URL(`/rest/v1/${c.table}${q}`,g.url),{...i,headers:{apikey:g.anonKey,Authorization:t,'Content-Type':'application/json',...(i.headers??{})}});onResponse?.(r);
 const x=r.status===204?'':await r.text();let p:unknown=null;
 try{p=x?JSON.parse(x):null;}catch{aiDbError(r.status,null);}
 if(!r.ok)aiDbError(r.status,p);
 return p as R;
}
export async function listAiRows(c:AiCatalog,t:string){c=await requireAiAccess(c,t,'view');return collectCatalogPages(c.primaryKey,`?select=*&order=${c.primaryKey}.asc`,(page,init,onResponse)=>request<Record<string,unknown>[]>(c,t,page,init,onResponse));}
export async function createAiRow(c:AiCatalog,t:string,i:Record<string,unknown>){c=await requireAiAccess(c,t,'create');const r=await request<Record<string,unknown>[]>(c,t,'',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(sanitize(c,i))});return r[0];}
export async function updateAiRow(c:AiCatalog,t:string,id:number,i:Record<string,unknown>){c=await requireAiAccess(c,t,'edit');const r=await request<Record<string,unknown>[]>(c,t,`?${c.primaryKey}=eq.${id}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(sanitize(c,i))});return r[0];}
export async function deleteAiRow(c:AiCatalog,t:string,id:number){c=await requireAiAccess(c,t,'delete');return request<null>(c,t,`?${c.primaryKey}=eq.${id}`,{method:'DELETE'});}
