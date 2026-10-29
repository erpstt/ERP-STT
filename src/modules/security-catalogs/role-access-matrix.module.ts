import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { invalidateReadCacheNamespace, ScopedReadCache } from '../../core/performance/scoped-read-cache.js';
import { coreCatalogs } from '../core-catalogs/core-catalogs.module.js';
import { securityCatalogs } from './security-catalogs.module.js';
import { organizationCatalogs } from '../organization-catalogs/organization-catalogs.module.js';
import { configurationCatalogs } from '../configuration-catalogs/configuration-catalogs.module.js';
import { accountingCatalogs } from '../accounting-catalogs/accounting-catalogs.module.js';
import { bankingCatalogs } from '../banking-catalogs/banking-catalogs.module.js';
import { treasuryCatalogs } from '../treasury-catalogs/treasury-catalogs.module.js';
import { entityCatalogs } from '../entity-catalogs/entity-catalogs.module.js';
import { inventoryCatalogs } from '../inventory-catalogs/inventory-catalogs.module.js';
import { salesCatalogs } from '../sales-catalogs/sales-catalogs.module.js';
import { transactionEngineCatalogs } from '../transaction-engine-catalogs/transaction-engine-catalogs.module.js';
import { purchasingCatalogs } from '../purchasing-catalogs/purchasing-catalogs.module.js';
import { expenseCatalogs } from '../expense-catalogs/expense-catalogs.module.js';
import { fixedAssetCatalogs } from '../fixed-asset-catalogs/fixed-asset-catalogs.module.js';
import { workflowCatalogs } from '../workflow-catalogs/workflow-catalogs.module.js';
import { documentCatalogs } from '../document-catalogs/document-catalogs.module.js';
import { auditCatalogs } from '../audit-catalogs/audit-catalogs.module.js';
import { consolidationCatalogs } from '../consolidation-catalogs/consolidation-catalogs.module.js';
import { aiCatalogs } from '../ai-catalogs/ai-catalogs.module.js';

type Action = 'view'|'create'|'edit'|'delete';
type Catalog = {slug:string;title:string};
export interface AccessResource { key:string; moduleKey:string; moduleName:string; optionName:string; actions:Action[]; }
export interface AccessModule { key:string; name:string; resources:AccessResource[]; }

const viewOnly = new Set([
  'permissions','sessions','devices','login-history','password-history','gl-impacts','audit-logs','system-logs',
  'consolidated-trial-balances','consolidated-financial-statements'
]);
const viewAndEditOnly = new Set(['user-subsidiaries']);
const noDelete = new Set(['users','roles','menus','journals','invoices','supplier-invoices','credit-notes','debit-notes','supplier-credit-notes','supplier-debit-notes']);
const catalogs = (moduleKey:string,moduleName:string,items:Catalog[]) => items.map(item => ({
  key:`${moduleKey}:${item.slug}`, moduleKey, moduleName, optionName:item.title,
  actions:(viewOnly.has(item.slug)?['view']:viewAndEditOnly.has(item.slug)?['view','edit']:noDelete.has(item.slug)?['view','create','edit']:['view','create','edit','delete']) as Action[]
}));
const custom = (moduleKey:string,moduleName:string,optionName:string,key:string,actions:Action[]=['view']) => ({key:`${moduleKey}:${key}`,moduleKey,moduleName,optionName,actions});

export const roleAccessModules:AccessModule[] = [
  {key:'core',name:'CORE',resources:catalogs('core','CORE',coreCatalogs)},
  {key:'security',name:'Seguridad',resources:catalogs('security','Seguridad',securityCatalogs).filter(x=>x.key!=='security:role-permissions')
    .concat([custom('security','Seguridad','Permisos por rol','role-access-matrix',['view','edit'])])},
  {key:'organization',name:'Organización',resources:catalogs('organization','Organización',organizationCatalogs)},
  {key:'configuration',name:'Configuración',resources:[
    custom('configuration','Configuración','Mantenimiento de Aprobadores UP','up-approvers',['view','edit']),
    custom('configuration','Configuración','Plantillas de Notificación','notification-templates',['view','edit']),
    ...catalogs('configuration','Configuración',configurationCatalogs)
  ]},
  {key:'accounting',name:'Contabilidad',resources:[...catalogs('accounting','Contabilidad',accountingCatalogs),
    custom('accounting','Contabilidad','Carga de Saldos Iniciales','opening-balances',['view','create','delete']),
    custom('accounting','Contabilidad','Reclasificación anual de pendientes','pending-invoice-reclassification',['view','create']),
    custom('accounting','Contabilidad','Solicitudes de Pago','payment-requests',['view','create','edit','delete']),
    custom('accounting','Contabilidad','Revaluación de moneda extranjera','fx-revaluation',['view','create']),
    custom('accounting','Contabilidad','Análisis de revaluación','fx-revaluation-analysis',['view'])]},
  {key:'banking',name:'Bancos',resources:[...catalogs('banking','Bancos',bankingCatalogs),custom('banking','Bancos','Prueba de efectivo (4 columnas)','cash-proof',['view','create','edit'])]},
  {key:'treasury',name:'Tesorería',resources:[...catalogs('treasury','Tesorería',treasuryCatalogs),
    custom('treasury','Tesorería','Solicitudes de Pago','payment-requests',['view','create','edit','delete']),
    custom('treasury','Tesorería','Generador de archivos de pago','payment-batches',['view','create']),
    custom('treasury','Tesorería','Historial de lotes','payment-batch-history',['view'])]},
  {key:'entities',name:'Entidades',resources:catalogs('entities','Entidades',entityCatalogs)},
  {key:'inventory',name:'Inventario',resources:catalogs('inventory','Inventario',inventoryCatalogs)},
  {key:'sales',name:'Ventas',resources:catalogs('sales','Ventas',salesCatalogs)},
  {key:'transaction-engine',name:'Motor Transacciones',resources:catalogs('transaction-engine','Motor Transacciones',transactionEngineCatalogs)},
  {key:'purchasing',name:'Compras',resources:catalogs('purchasing','Compras',purchasingCatalogs)},
  {key:'expenses',name:'Gastos',resources:catalogs('expenses','Gastos',expenseCatalogs)},
  {key:'tax',name:'Fiscal',resources:[
    custom('tax','Fiscal','Obligaciones tributarias','tax-obligations',['view','create','edit','delete']),
    custom('tax','Fiscal','Calendario tributario','tax-calendar',['view','create','edit','delete'])]},
  {key:'fixed-assets',name:'Activos Fijos',resources:[...catalogs('fixed-assets','Activos Fijos',fixedAssetCatalogs),
    custom('fixed-assets','Activos Fijos','Propuestas de Capitalización','asset-proposals',['view','create','edit']),
    custom('fixed-assets','Activos Fijos','Reportes','reports',['view'])]},
  {key:'workflow',name:'Workflow',resources:[
    custom('workflow','Workflow','Mis aprobaciones','approval-inbox',['view','edit']),
    custom('workflow','Workflow','Configuración de Flujos de Aprobación','approval-workflows',['view','create','edit','delete']),
    ...catalogs('workflow','Workflow',workflowCatalogs)]},
  {key:'documents',name:'Documentos',resources:[custom('documents','Documentos','Diseñador de Plantillas PDF','pdf-templates',['view','create','edit','delete']),...catalogs('documents','Documentos',documentCatalogs)]},
  {key:'audit',name:'Auditoría',resources:[custom('audit','Auditoría','Transacciones modificadas y eliminadas','change-report',['view']),...catalogs('audit','Auditoría',auditCatalogs).map(x=>({...x,actions:['view'] as Action[]}))]},
  {key:'consolidation',name:'Consolidación',resources:[custom('consolidation','Consolidación','Consolidación financiera','financial-consolidation',['view','create','edit']),...catalogs('consolidation','Consolidación',consolidationCatalogs)]},
  {key:'reports',name:'Informes',resources:[custom('reports','Informes','Reportes de Contabilidad','accounting-reports',['view']),custom('reports','Informes','Envíos programados','scheduled-reports',['view','create','edit','delete'])]},
  {key:'ai',name:'IA',resources:catalogs('ai','IA',aiCatalogs)}
];
const roleAccessResourceKeys=new Set(roleAccessModules.flatMap(module=>module.resources.map(resource=>resource.key)));
export const isRoleAccessResource=(resourceKey:string)=>roleAccessResourceKeys.has(resourceKey);
type RoleAccessGrant={resourceKey:string;canView:boolean;canCreate:boolean;canEdit:boolean;canDelete:boolean};
type MyRoleAccessData={isAdmin:boolean;grants:RoleAccessGrant[];modules:AccessModule[]};
// El límite de 30 s conserva una ventana acotada y todas las mutaciones locales
// invalidan inmediatamente; evita revalidar toda la matriz durante navegación.
const myRoleAccessCache=new ScopedReadCache<MyRoleAccessData>({defaultTtlMs:30_000});
const myRoleAccessNamespace='security-my-role-access';
function accessCacheScope(token:string){
 const raw=token.replace(/^Bearer\s+/i,'').trim();if(!raw)throw new Error('La sesión no es válida.');
 try{const part=raw.split('.')[1];if(!part)throw new Error();const value=JSON.parse(Buffer.from(part,'base64url').toString('utf8'))as Record<string,unknown>;return[String(value.sub??'unknown'),String(value.session_id??value.sub??'unknown')];}
 catch{return['opaque',raw];}
}
export function invalidateRoleAccessCaches(token?:string){
  if(token){myRoleAccessCache.invalidate(myRoleAccessNamespace,accessCacheScope(token));return;}
  invalidateReadCacheNamespace(myRoleAccessNamespace);
}

function completeRoleAccess(data:Omit<MyRoleAccessData,'modules'>):MyRoleAccessData{
  return{isAdmin:data.isAdmin===true,grants:Array.isArray(data.grants)?data.grants:[],modules:roleAccessModules};
}

export function primeRoleAccessCache(token:string,data:Omit<MyRoleAccessData,'modules'>){
  invalidateRoleAccessCaches(token);
  return myRoleAccessCache.getOrLoad({namespace:myRoleAccessNamespace,scope:accessCacheScope(token),loader:async()=>completeRoleAccess(data)});
}

async function rpc<T>(token:string,name:string,payload:Record<string,unknown>={}):Promise<T>{
  const config=getSupabaseConfig();if(!config)throw new Error('Supabase no está configurado.');
  const response=await fetchSupabase(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:token,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const text=await response.text();const data:unknown=text?JSON.parse(text):null;
  if(!response.ok){const message=typeof data==='object'&&data!==null&&'message'in data?String(data.message):'No fue posible consultar los permisos.';const error=new Error(message)as Error&{status?:number};error.status=response.status===401?401:403;throw error;}
  return data as T;
}

export async function roleAccessMatrix(token:string,roleId:number){
  const data=await rpc<{selectedRoleId:number;roles:Array<{roleId:number;name:string;description:string|null;isSystemRole:boolean}>;grants:Array<{resourceKey:string;canView:boolean;canCreate:boolean;canEdit:boolean;canDelete:boolean}>;specialPermissions:Array<{permissionId:number;code:string;module:string;description:string|null;enabled:boolean}>;isAdministratorRole:boolean}>(token,'security_role_access_matrix_data',{p_role_id:roleId||null});
  return {...data,modules:roleAccessModules};
}
export async function saveRoleAccessMatrix(token:string,input:Record<string,unknown>){
  const roleId=Number(input.roleId);if(!Number.isInteger(roleId)||roleId<=0)throw new Error('Seleccione un rol válido.');
  const valid=new Map(roleAccessModules.flatMap(m=>m.resources).map(r=>[r.key,r]));
  const entries=(Array.isArray(input.entries)?input.entries:[]).map(raw=>{
    const value=raw as Record<string,unknown>,resource=valid.get(String(value.resourceKey));if(!resource)throw new Error('La matriz contiene una opción no válida.');
    const allows=(action:Action)=>resource.actions.includes(action)&&value[`can${action[0].toUpperCase()}${action.slice(1)}`]===true;
    return{resourceKey:resource.key,canView:allows('view'),canCreate:allows('create'),canEdit:allows('edit'),canDelete:allows('delete')};
  });
  const permissionIds=[...new Set((Array.isArray(input.specialPermissionIds)?input.specialPermissionIds:[]).map(Number))];
  if(permissionIds.some(id=>!Number.isInteger(id)||id<=0))throw new Error('La selección de permisos especiales no es válida.');
  const result=await rpc(token,'security_save_role_access_matrix',{p_role_id:roleId,p_entries:entries,p_permission_ids:permissionIds});invalidateRoleAccessCaches();return result;
}
export const myRoleAccess=(token:string)=>myRoleAccessCache.getOrLoad({namespace:myRoleAccessNamespace,scope:accessCacheScope(token),loader:async()=>completeRoleAccess(await rpc<Omit<MyRoleAccessData,'modules'>>(token,'security_my_role_access'))});
export async function assertRoleAccess(token:string,resourceKey:string,action:Action){
  const access=await myRoleAccess(token);
  const property:Record<Action,keyof RoleAccessGrant>={view:'canView',create:'canCreate',edit:'canEdit',delete:'canDelete'};
  const allowed=access.isAdmin||access.grants.some(grant=>grant.resourceKey==='legacy:all'||(grant.resourceKey===resourceKey&&grant[property[action]]===true));
  if(allowed)return null;
  const failure=new Error('El rol activo no tiene permiso para realizar esta acción.')as Error&{status?:number};failure.status=403;throw failure;
}
