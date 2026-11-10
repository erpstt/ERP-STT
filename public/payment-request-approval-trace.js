// Read-only presentation of the recorded workflow. This module never resolves
// approval rules, changes a decision, or makes a network request.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const sameId=(left,right)=>left!=null&&right!=null&&String(left)===String(right);
const statuses={
  approved:{label:'Aprobada',icon:'✓'},current:{label:'Pendiente de aprobación',icon:'●'},
  future:{label:'Siguiente etapa',icon:'○'},rejected:{label:'Rechazada',icon:'×'},
  cancelled:{label:'Anulada',icon:'—'},stopped:{label:'Detenida',icon:'—'},
  skipped:{label:'Omitida',icon:'—'},unknown:{label:'Sin decisión registrada',icon:'?'}
};
const sources={COST_CENTER:'Proyectos (UP) · Centro de costo',SUBSIDIARY:'Proyectos (UP) · Subsidiaria',ADMINISTRATIVE:'Aprobador Administrativo',TAX_SUPERVISOR:'Supervisor tributario',ADMIN_FALLBACK:'Administrador autorizado'};

function stepState(step,instance,header){
  if(step.status==='APROBADO')return 'approved';
  if(step.status==='RECHAZADO')return 'rejected';
  if(step.status==='OMITIDO')return 'skipped';
  if(['CANCELADO','ANULADO'].includes(step.status))return 'cancelled';
  if(!['PENDIENTE','EN_REVISION'].includes(step.status))return 'unknown';
  if(instance.status==='CANCELADO'||header.estado==='ANULADO')return 'cancelled';
  if(instance.status==='RECHAZADO'||header.estado==='RECHAZADO')return 'stopped';
  const reviewing=instance.status==='EN_REVISION'&&!['APROBADO','APLICADO','RECHAZADO','ANULADO','BORRADOR'].includes(header.estado);
  if(reviewing&&Number.isInteger(Number(instance.currentLevel))&&Number(instance.currentLevel)>0){
    if(Number(step.level)===Number(instance.currentLevel))return 'current';
    if(Number(step.level)>Number(instance.currentLevel))return 'future';
  }
  return 'unknown';
}
function assignee(step,users){
  const names=[];
  if(step.userId!=null){const user=users.find(item=>sameId(item.id,step.userId));names.push(user?.name||`Usuario #${step.userId}`);}
  if(step.roleId!=null)names.push(`Rol #${step.roleId}`);
  return names.join(' o ')||'Responsable no informado';
}
function dateLabel(value){if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('es-CR');}
function decisionsMarkup(step){
  const decisions=(Array.isArray(step.decisions)?step.decisions:[]).filter(decision=>['APROBAR','RECHAZAR'].includes(decision.action));
  if(!decisions.length)return '';
  return '<ul class="approval-trace-decisions" aria-label="Decisiones registradas">'+decisions.map(decision=>{
    const actor=decision.userName||(decision.userId!=null?`Usuario #${decision.userId}`:'Usuario no informado'),date=dateLabel(decision.at),role=decision.roleName||(decision.roleId!=null?`Rol #${decision.roleId}`:'');
    return `<li><strong>${decision.action==='APROBAR'?'Aprobó':'Rechazó'}:</strong> <span data-i18n-ignore>${esc(actor)}</span>${role?` <span class="approval-trace-role" data-i18n-ignore>(${esc(role)})</span>`:''}${date?`<time>${esc(date)}</time>`:''}${decision.comment?`<p class="approval-trace-comment" data-i18n-ignore>${esc(decision.comment)}</p>`:''}</li>`;
  }).join('')+'</ul>';
}
function policyMarkup(step){
  if(step.policy!=='TODOS')return step.roleId!=null?'<p class="approval-trace-policy">Basta una aprobación de los responsables del rol.</p>':'';
  const required=Number(step.requiredCount);
  if(!Number.isInteger(required)||required<1)return '<p class="approval-trace-policy">Requiere la aprobación de todos los responsables.</p>';
  const approvals=new Set((Array.isArray(step.decisions)?step.decisions:[]).filter(item=>item.action==='APROBAR'&&item.userId!=null).map(item=>String(item.userId))).size;
  return `<p class="approval-trace-policy">${approvals} de ${required} aprobaciones registradas · Requiere todas.</p>`;
}

export function renderPaymentRequestApprovalTrace({trace,header={},users=[]}={}){
  const title='<div class="approval-trace-heading"><h4>Etapas de aprobación</h4><p>Responsables y decisiones de la ruta registrada para esta solicitud.</p></div>';
  const empty=message=>`<section class="approval-trace" aria-label="Etapas de aprobación">${title}<p class="approval-trace-notice">${message}</p></section>`;
  if(trace?.state==='NOT_STARTED')return empty(header.estado==='BORRADOR'?'La ruta y sus responsables se asignarán al enviar la solicitud a aprobación.':'No hay una ruta de aprobación registrada para esta solicitud.');
  if(trace?.state!=='AVAILABLE')return empty('No fue posible consultar las etapas de aprobación. El historial de la solicitud permanece disponible.');
  const steps=Array.isArray(trace.steps)?trace.steps.filter(item=>item&&typeof item==='object').slice().sort((a,b)=>Number(a.level)-Number(b.level)):[],instance=trace.instance||{};
  if(!steps.length)return empty('El flujo registrado no contiene etapas de aprobación.');
  const directory=Array.isArray(users)?users:[],items=steps.map(step=>({step,state:stepState(step,instance,header)})),current=items.find(item=>item.state==='current');
  const summary=current?`<p class="approval-trace-current"><strong>Debe aprobar ahora:</strong> <span data-i18n-ignore>${esc(assignee(current.step,directory))}</span></p>`:'';
  const legend='<ul class="approval-trace-legend" aria-label="Leyenda de estados"><li><span class="approval-trace-light" data-state="approved" aria-hidden="true"></span>Aprobada</li><li><span class="approval-trace-light" data-state="current" aria-hidden="true"></span>Pendiente</li><li><span class="approval-trace-light" data-state="future" aria-hidden="true"></span>Siguiente</li><li><span class="approval-trace-light" data-state="rejected" aria-hidden="true"></span>Rechazada</li></ul>';
  const list=items.map(({step,state})=>{
    const status=statuses[state],source=sources[step.source],level=step.level??'—';
    return `<li class="approval-trace-step" data-state="${state}"${state==='current'?' aria-current="step"':''}><span class="approval-trace-marker" aria-hidden="true">${status.icon}</span><div class="approval-trace-content"><div class="approval-trace-step-heading"><h5><span>Etapa ${esc(level)}</span> <span data-i18n-ignore>${esc(step.name||`Nivel ${level}`)}</span></h5><span class="approval-trace-status">${status.label}</span></div><p class="approval-trace-assignee"><strong>Asignado a:</strong> <span data-i18n-ignore>${esc(assignee(step,directory))}</span></p>${source?`<p class="approval-trace-source">${source}</p>`:''}${policyMarkup(step)}${decisionsMarkup(step)}</div></li>`;
  }).join('');
  return `<section class="approval-trace" aria-label="Etapas de aprobación">${title}${summary}${legend}<ol class="approval-trace-steps">${list}</ol></section>`;
}
