import{fetchSupabase,getSupabaseConfig}from'../../core/database/supabase.client.js';
async function rpc<T>(token:string,name:string,payload:Record<string,unknown>={}){const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:token,'Content-Type':'application/json'},body:JSON.stringify(payload)}),text=await response.text(),data=text?JSON.parse(text):null;if(!response.ok)throw Error(data?.message||'No fue posible ejecutar la consolidación.');return data as T;}
export const consolidationOptions=(t:string)=>rpc(t,'consolidation_options');
export const consolidationInit=(t:string,p:Record<string,unknown>)=>rpc(t,'consolidation_init',{p_period:p.period});
export const consolidationTranslate=(t:string,id:number)=>rpc(t,'consolidation_translate',{p_run:id});
export const consolidationProcess=(t:string,id:number)=>rpc(t,'consolidation_process',{p_run:id});
export const consolidationWorksheet=(t:string,id:number)=>rpc(t,'consolidation_worksheet_data',{p_run:id});
export const consolidationPublish=(t:string,id:number)=>rpc(t,'consolidation_publish',{p_run:id});
