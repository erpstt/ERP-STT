import {approvalEngine} from '../workflow-catalogs/approval-engine.service.js';

type Row=Record<string,unknown>;
export type ApprovalTraceHistory={
  id:number;level:number|null;action:string;userId:number|null;userName:string|null;
  roleId:number|null;roleName:string|null;at:string|null;comment:string|null;
};
type Decision=Omit<ApprovalTraceHistory,'level'>;
export type ApprovalTrace={
  state:'AVAILABLE'|'NOT_STARTED'|'UNAVAILABLE';
  instance:{id:number;status:string;currentLevel:number|null;createdAt:string|null;completedAt:string|null}|null;
  steps:Array<{id:number;level:number;name:string;status:string;policy:string;requiredCount:number;
    userId:number|null;roleId:number|null;source:string|null;decisions:Decision[]}>;
  history:ApprovalTraceHistory[];
};
const empty=(state:'NOT_STARTED'|'UNAVAILABLE'):ApprovalTrace=>({state,instance:null,steps:[],history:[]});
const row=(value:unknown):Row|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Row:null;
function id(value:unknown):number|null{
  if(typeof value!=='string'&&typeof value!=='number')return null;
  if(!/^[1-9][0-9]*$/.test(String(value)))return null;
  const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:null;
}
const text=(value:unknown,max=1000):string|null=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;
const date=(value:unknown):string|null=>typeof value==='string'&&value.length<=50&&Number.isFinite(Date.parse(value))?value:null;
const validOptionalId=(value:unknown):boolean=>value==null||id(value)!==null;
const sources=new Set(['STANDARD','COST_CENTER','SUBSIDIARY','MIXED','ADMINISTRATIVE','TAX_SUPERVISOR','ADMIN_FALLBACK','LEGACY_UP','LEGACY']);

// Display data comes from the copied instance. Current configuration is never
// resolved again, and an assigned user is distinct from the recorded actor.
function project(value:unknown,requestId:number):ApprovalTrace{
  if(value===null)return empty('NOT_STARTED');
  const detail=row(value),instance=row(detail?.instance),instanceId=id(instance?.id);
  if(!detail||!instance||!instanceId||instance.entity_type!=='PAYMENT_REQUEST'
    ||id(instance.entity_id)!==requestId||!Array.isArray(detail.steps)||!Array.isArray(detail.history))return empty('UNAVAILABLE');
  const status=text(instance.status,80),currentLevel=id(instance.current_level);
  if(!status||(instance.current_level!=null&&currentLevel===null))return empty('UNAVAILABLE');
  const history:ApprovalTraceHistory[]=[];
  for(const value of detail.history){
    const record=row(value),recordId=id(record?.id),action=text(record?.accion_tomada,80);
    if(!record||!recordId||!action||id(record.instance_id)!==instanceId
      ||![record.nivel,record.usuario_id,record.rol_id].every(validOptionalId))return empty('UNAVAILABLE');
    history.push({id:recordId,level:id(record.nivel),action,userId:id(record.usuario_id),userName:text(record.user,320),
      roleId:id(record.rol_id),roleName:text(record.role,320),at:date(record.fecha_hora),comment:text(record.comentario_motivo,4000)});
  }
  const decisionsByLevel=new Map<number,Decision[]>();
  for(const {level,...decision} of history){
    if(level===null||!['APROBAR','RECHAZAR'].includes(decision.action))continue;
    const decisions=decisionsByLevel.get(level)??[];decisions.push(decision);decisionsByLevel.set(level,decisions);
  }
  const copied=row(instance.approval_context)?.approvalSteps;
  const steps:ApprovalTrace['steps']=[];
  for(const value of detail.steps){
    const step=row(value),stepId=id(step?.id),level=id(step?.nivel),name=text(step?.nombre_nivel),stepStatus=text(step?.status,80);
    const userId=id(step?.usuario_aprobador_id),roleId=id(step?.rol_aprobador_id),requiredCount=id(step?.required_count);
    if(!step||!stepId||!level||!name||!stepStatus||!requiredCount||id(step.instance_id)!==instanceId
      ||![step.usuario_aprobador_id,step.rol_aprobador_id].every(validOptionalId)
      ||!['CUALQUIERA','TODOS'].includes(String(step.politica)))return empty('UNAVAILABLE');
    const metadata=Array.isArray(copied)?row(copied[level-1]):null;
    const copiedSource=text(metadata?.source,80);
    const source=metadata&&(userId!==null||roleId!==null)&&[metadata.approverId,metadata.roleId].every(validOptionalId)
      &&id(metadata.approverId)===userId&&id(metadata.roleId)===roleId
      &&copiedSource&&sources.has(copiedSource)?copiedSource:null;
    steps.push({id:stepId,level,name,status:stepStatus,policy:String(step.politica),requiredCount,userId,roleId,source,
      decisions:decisionsByLevel.get(level)??[]});
  }
  steps.sort((a,b)=>a.level-b.level);
  if(new Set(steps.map(step=>step.level)).size!==steps.length
    ||new Set(steps.map(step=>step.id)).size!==steps.length
    ||(currentLevel!==null&&!steps.some(step=>step.level===currentLevel)))return empty('UNAVAILABLE');
  return{state:'AVAILABLE',instance:{id:instanceId,status,currentLevel,createdAt:date(instance.created_at),completedAt:date(instance.completed_at)},steps,history};
}

export async function paymentRequestApprovalTrace(auth:string,headerId:unknown):Promise<ApprovalTrace>{
  const requestId=id(headerId);if(!requestId)return empty('UNAVAILABLE');
  try{
    const detail=await approvalEngine(auth,'detail',{entityType:'PAYMENT_REQUEST',entityId:requestId});
    return project(detail,requestId);
  }catch(error){
    const status=(error as {status?:number})?.status;
    if(status===401||status===403)throw error;
    return empty('UNAVAILABLE');
  }
}
