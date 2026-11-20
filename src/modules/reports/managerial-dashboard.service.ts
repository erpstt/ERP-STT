import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {assertRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
export async function runManagerialDashboard(auth:string,input:Record<string,unknown>){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(new Error('Debe iniciar sesión.'),{status:401});
 await assertRoleAccess(auth,'dashboard:managerial','view');
 if(!input||Object.keys(input).some(k=>!['month','roleId','userId','subsidiaryId'].includes(k))||typeof input.month!=='string'||!/^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$/.test(input.month)||['roleId','userId','subsidiaryId'].some(k=>input[k]!==null&&input[k]!==undefined&&(!Number.isSafeInteger(input[k])||Number(input[k])<=0)))throw Object.assign(new Error('Seleccione un mes, usuario y rol válidos.'),{status:400});
 const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL('/rest/v1/rpc/run_managerial_dashboard',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({p_month:input.month,p_role_id:input.roleId??null,p_user_id:input.userId??null,p_subsidiary_id:input.subsidiaryId??null})});
 const data=await response.json();if(!response.ok)throw Object.assign(new Error(response.status===401?'La sesión no es válida.':data?.code==='42501'||response.status===403?'El rol activo no tiene acceso al Dashboard o a la sociedad seleccionada.':data?.code==='22023'?'Revise el mes, usuario y rol seleccionados.':'No fue posible consultar el Dashboard. Intente nuevamente.'),{status:response.status===401?401:data?.code==='42501'||response.status===403?403:data?.code==='22023'?400:503});
 return data;
}
