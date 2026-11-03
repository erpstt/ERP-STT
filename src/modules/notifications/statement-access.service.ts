import {assertRoleAccess,myRoleAccess} from '../security-catalogs/role-access-matrix.module.js';
import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';

export async function requireCustomerStatementAccess(auth:string,action:string){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 if(!['get','pdf','send'].includes(action))throw Object.assign(Error('Acción de estado de cuenta inválida.'),{status:400});
 await assertRoleAccess(auth,'reports:accounting-reports','view');
 await assertRoleAccess(auth,'entities:customers','view');
 if(action==='send')await assertRoleAccess(auth,'entities:customers','edit');
}
export async function requireStatementSettingsAccess(auth:string,action:string){
 if(!/^Bearer\s+\S+$/i.test(auth||''))throw Object.assign(Error('Debe iniciar sesión.'),{status:401});
 if(!['get','save','preview'].includes(action))throw Object.assign(Error('Acción de configuración inválida.'),{status:400});
 await assertRoleAccess(auth,'configuration:notification-templates',action==='save'?'edit':'view');
}
export async function customerStatementCapabilities(auth:string){
 const access=await myRoleAccess(auth),grant=access.grants.find(g=>g.resourceKey==='entities:customers');
 return{canView:true,canDownload:true,canSend:access.isAdmin||grant?.canView===true&&grant?.canEdit===true};
}
export async function statementRpc(auth:string,name:string,parameters:Record<string,unknown>){
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL('/rest/v1/rpc/'+name,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(parameters)});
 const result=await response.json();
 if(!response.ok){const status=response.status===401?401:response.status===403||result?.code==='42501'?403:['22023','22P02','22007','22008','P0001'].includes(result?.code)?400:500;throw Object.assign(Error(status===403?'El rol activo no puede consultar o enviar este estado de cuenta.':status===400?'Revise cliente, fecha, subsidiaria y configuración del estado de cuenta.':'No fue posible procesar el estado de cuenta.'),{status});}
 return result;
}
