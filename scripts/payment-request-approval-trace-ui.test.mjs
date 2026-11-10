import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Real browser modules and production workspace assets, with a closed allowlist
// of synthetic read APIs. No application backend or real session is used.
const server=await readFile(new URL('../src/server.ts',import.meta.url),'utf8');
const branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'Represent the production static HTML assets');
function served(raw){return raw.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+branding[1]).replace(/<head\b[^>]*>/i,head=>head+renewal[1]);}
const users=[{id:1,name:'solicitante@example.invalid'},{id:11,name:'up-y-administrativo@example.invalid'},{id:12,name:'segundo-up@example.invalid'},
  {id:21,name:'directorio-actual@example.invalid'},{id:999,name:'no-usar-header@example.invalid'}];
const options={company:'Subsidiaria de trazabilidad',userId:1,admin:false,baseCurrencyId:1,currencies:[{id:1,name:'CRC'}],users,
  suppliers:[{id:10,name:'Proveedor sintético'}],accounts:[{id:203,name:'Cuenta sintética'}],departments:[{id:21,name:'Departamento sintético',type:'Interno'}],
  customers:[],employees:[],otherNames:[],taxAgencies:[],costCenters:[],banks:[],rates:[],beneficiaryBankAccounts:[]};
const header={id:7,numero:'SOL-TRACE-7',estado:'PENDIENTE_APROBACION',tipo_solicitud:'OTROS',id_solicitante:1,id_moneda:1,
  fecha_solicitud:'2026-11-10',fecha_pago_programada:'2026-11-20',concepto:'Detalle financiero preservado',total:50,version:4,moneda:'CRC',solicitante:'Solicitante sintético',
  assigned_approver_id:999,approval_route_source:'MIXED'};
const line={id_cuenta_contable:203,tipo_tercero:'Proveedor',id_proveedor:10,id_departamento:21,departmentType:'Interno',department:'Departamento sintético',
  accountName:'Cuenta sintética',party:'Proveedor sintético',concepto:'Partida sintética',monto:50};
const decision=(id,action,userId,userName,extra={})=>({id,action,userId,userName,roleId:2,roleName:'Rol ejercido',at:'2026-11-10T18:30:00Z',comment:'Decisión registrada',...extra});
const step=(level,extra={})=>({id:100+level,level,name:`Etapa ${level}`,status:'PENDIENTE',policy:'CUALQUIERA',requiredCount:1,userId:level===2?12:11,roleId:null,source:level===3?'ADMINISTRATIVE':'COST_CENTER',decisions:[],...extra});
const trace=(extra={})=>({state:'AVAILABLE',instance:{id:101,status:'EN_REVISION',currentLevel:2,createdAt:'2026-11-10T18:00:00Z',completedAt:null},
  steps:[step(1,{name:'Proyectos UP inicial',status:'APROBADO',decisions:[decision(301,'APROBAR',21,'Actor histórico real')]}),step(2,{name:'Segundo responsable UP'}),step(3,{name:'Aprobador Administrativo'})],history:[],...extra});
const states=frame=>frame.locator('.approval-trace-step').evaluateAll(elements=>elements.map(element=>element.dataset.state));
const component=frame=>frame.locator('#audit > .approval-trace');
const noActions=async frame=>assert.equal(await component(frame).locator('button,input,select,textarea,form,a,[data-transition],[data-approve],[data-reject]').count(),0,'The trace must not expose decision or financial controls');

async function fixture(t,{approvalTrace=trace(),requestState='PENDIENTE_APROBACION',events=[],width=1440,deny=null,directory=users}={}){
  const {page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000});
  const calls=[],unexpected=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','synthetic-approval-trace-token');localStorage.setItem('nexo_device_token','synthetic-approval-trace-device');
    localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');
  });
  const current={...header,estado:requestState};
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==baseURL){await route.fallback();return;}
    if(url.pathname==='/payment-requests.html'){
      await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile(new URL('../public/payment-requests.html',import.meta.url),'utf8'))});return;
    }
    if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
    const method=request.method(),body=method==='POST'?request.postDataJSON():null,path=url.pathname;
    calls.push({method,path,body});
    try{
      assert.equal(request.headers().authorization,'Bearer synthetic-approval-trace-token');
      assert.equal(request.headers()['x-device-token'],'synthetic-approval-trace-device');
      if(path==='/api/audit/record-actor'){
        assert.equal(method,'GET');assert.equal(url.searchParams.get('table'),'solicitudes_pago');assert.equal(url.searchParams.get('id'),'7');
        await route.fulfill({json:{}});return;
      }
      const prefix='/api/treasury/payment-requests/';assert.ok(path.startsWith(prefix),'Only the request read API may be consulted');
      const action=path.slice(prefix.length);assert.ok(['access','options','report','detail','supports'].includes(action),'Mutation or additional API blocked');
      assert.equal(method,['access','options'].includes(action)?'GET':'POST');
      if(['detail','supports'].includes(action)){assert.deepEqual(Object.keys(body),['id']);assert.equal(String(body.id),'7');}
      if(action==='report'){
        assert.deepEqual(Object.keys(body).sort(),['dateField','from','requesterId','status','supplierId','to','type'].sort());
        assert.equal(body.dateField,'request');for(const key of ['requesterId','status','supplierId','type'])assert.equal(body[key],'');
        for(const key of ['from','to'])assert.match(body[key],/^(?:|\d{4}-\d{2}-\d{2})$/);
      }
      if(action===deny){await route.fulfill({status:403,json:{error:{message:'Consulta protegida de trazabilidad.'}}});return;}
      const payload=action==='access'?{canView:true,canCreate:false,canEdit:false,canDelete:false}:action==='options'?{...options,users:directory}:action==='report'?[current]:action==='supports'?[]:
        {header:current,lines:[line],events,beneficiaryBankAccounts:[],approvalTrace,
          actions:{canEdit:false,canSubmit:true,canApprove:true,canExecute:true,canCancel:true}};
      await route.fulfill({json:payload});
    }catch(error){unexpected.push({method,path,body,error:error.message});await route.fulfill({status:501,json:{error:{message:'Synthetic read allowlist rejected this request'}}});}
  });
  await page.goto(baseURL);
  await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/payment-requests.html?id=7"></iframe></body></html>');
  const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
  if(deny)await frame.locator('#message.error').waitFor();
  else await component(frame).waitFor();
  t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
  return{page,frame,calls};
}
async function capture(page,name){
  if(process.env.APPROVAL_TRACE_CAPTURE!=='1')return;
  const directory=resolve('.local-tools/approval-trace-qa');await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,name),animations:'disabled'});
}

test('UP y Administrativo conservan etapas e identidades reales incluso con el mismo usuario y eventos contradictorios',{timeout:30000},async t=>{
  const {page,frame}=await fixture(t,{events:[{accion:'APROBADO',user:'Actor de otro ciclo',fecha:'2026-11-01T00:00:00Z',nota:'Historial independiente'}]});
  assert.deepEqual(await states(frame),['approved','current','future']);
  const stages=frame.locator('.approval-trace-step');assert.equal(await stages.count(),3);
  const assigned=await stages.locator('.approval-trace-assignee').allTextContents();
  assert.match(assigned[0],/up-y-administrativo@example.invalid/);assert.match(assigned[1],/segundo-up@example.invalid/);assert.match(assigned[2],/up-y-administrativo@example.invalid/);
  assert.match(await stages.nth(0).innerText(),/Actor histórico real/);assert.doesNotMatch(await component(frame).innerText(),/no-usar-header|directorio-actual|Actor de otro ciclo|delegad/i);
  assert.equal(await stages.nth(1).getAttribute('aria-current'),'step');
  assert.match(await frame.locator('#audit > .timeline').innerText(),/Actor de otro ciclo/);
  await noActions(frame);await component(frame).scrollIntoViewIfNeeded();await capture(page,'desktop-pending.png');
  if(process.env.APPROVAL_TRACE_CAPTURE==='1'){await page.setViewportSize({width:390,height:1000});await component(frame).scrollIntoViewIfNeeded();await capture(page,'mobile-pending.png');}
});

test('TODOS con decisión parcial permanece pendiente y cuenta personas distintas sin aprobar el nivel futuro',{timeout:30000},async t=>{
  const partial=trace({instance:{id:102,status:'EN_REVISION',currentLevel:1},steps:[step(1,{policy:'TODOS',requiredCount:2,userId:null,roleId:6,
    decisions:[decision(301,'APROBAR',21,'Primera aprobadora real'),decision(302,'APROBAR',21,'Primera aprobadora real')]}),step(2,{source:'ADMINISTRATIVE'})]});
  const {frame}=await fixture(t,{approvalTrace:partial});
  assert.deepEqual(await states(frame),['current','future']);
  const current=frame.locator('.approval-trace-step').first();assert.match(await current.innerText(),/1 de 2 aprobaciones/);assert.match(await current.innerText(),/Primera aprobadora real/);
  assert.match(await current.locator('.approval-trace-assignee').innerText(),/Rol #6/);await noActions(frame);
});

test('rechazo, anulación y aprobación final conservan decisiones previas y no dejan una etapa activa',{timeout:60000},async t=>{
  for(const [status,requestState,expected] of [['RECHAZADO','RECHAZADO',['approved','rejected','stopped']],['CANCELADO','ANULADO',['approved','cancelled','cancelled']],['APROBADO','APLICADO',['approved','approved','approved']]]){
    const approvalTrace=trace();approvalTrace.instance.status=status;
    if(status==='RECHAZADO'){approvalTrace.steps[1].status='RECHAZADO';approvalTrace.steps[1].decisions=[decision(302,'RECHAZAR',12,'Responsable que rechazó')];}
    if(status==='APROBADO')approvalTrace.steps.forEach(item=>{item.status='APROBADO';});
    const {page,frame}=await fixture(t,{approvalTrace,requestState});
    assert.deepEqual(await states(frame),expected);assert.equal(await component(frame).locator('[aria-current="step"]').count(),0);
    assert.equal(await component(frame).locator('.approval-trace-current').count(),0);await noActions(frame);
    await component(frame).scrollIntoViewIfNeeded();await capture(page,`desktop-${status==='RECHAZADO'?'rejected':status==='CANCELADO'?'cancelled':'approved'}.png`);
  }
});

test('un nuevo envío usa su instancia y la ausencia o fallo de etapas conserva el detalle sin inventar responsables',{timeout:60000},async t=>{
  const fresh=trace({instance:{id:202,status:'EN_REVISION',currentLevel:1},steps:[step(1),step(2,{source:'ADMINISTRATIVE'})],history:[]});
  const reopened=await fixture(t,{approvalTrace:fresh,events:[{accion:'RECHAZADO',user:'Actor del ciclo anterior',fecha:'2026-11-01T00:00:00Z',nota:'Rechazo anterior'}]});
  assert.deepEqual(await states(reopened.frame),['current','future']);assert.doesNotMatch(await component(reopened.frame).innerText(),/Actor del ciclo anterior/);
  assert.match(await reopened.frame.locator('#audit > .timeline').innerText(),/Actor del ciclo anterior/);
  for(const [approvalTrace,requestState,notice] of [[{state:'NOT_STARTED',instance:null,steps:[],history:[]},'BORRADOR',/asignarán al enviar/],
    [{state:'UNAVAILABLE',instance:null,steps:[],history:[]},'PENDIENTE_APROBACION',/No fue posible consultar/],[null,'PENDIENTE_APROBACION',/No fue posible consultar/]]){
    const {frame}=await fixture(t,{approvalTrace,requestState});
    assert.deepEqual(await states(frame),[]);assert.match(await component(frame).innerText(),notice);
    assert.equal(await frame.locator('#detailConcept').innerText(),header.concepto);assert.doesNotMatch(await component(frame).innerText(),/no-usar-header|up-y-administrativo/);await noActions(frame);
  }
});

test('denegar acceso o detalle no muestra responsables ni consulta una ruta alternativa',{timeout:30000},async t=>{
  for(const deny of ['access','detail']){
    const {frame,calls}=await fixture(t,{deny});
    assert.equal(await frame.locator('.approval-trace').count(),0);assert.doesNotMatch(await frame.locator('#audit').innerText(),/up-y-administrativo|Actor histórico real/);
    if(deny==='access')assert.deepEqual(calls.map(call=>call.path),['/api/treasury/payment-requests/access']);
    else assert.equal(calls.filter(call=>call.path==='/api/treasury/payment-requests/detail').length,1);
    assert.ok(calls.every(call=>!call.path.startsWith('/api/approval-engine/')));
  }
});

test('etapas y decisiones hostiles se ven como texto en móvil y el componente no ofrece mutaciones',{timeout:30000},async t=>{
  const attack='<img src=x onerror="window.approvalTraceXss=true"> & <script>window.approvalTraceXss=true</script>',approvalTrace=trace();
  approvalTrace.steps[0].name=attack.repeat(3);approvalTrace.steps[0].decisions=[decision(301,'APROBAR',21,attack,{roleName:attack,comment:attack})];
  const {page,frame}=await fixture(t,{approvalTrace,width:390,directory:users.map(user=>user.id===11?{...user,name:attack}:user)});
  const scope=component(frame);assert.match(await scope.innerText(),/<img src=x/);assert.equal(await scope.locator('img,script,iframe,[onerror],[onclick]').count(),0);
  assert.equal(await frame.evaluate(()=>window.approvalTraceXss),undefined);assert.deepEqual(await states(frame),['approved','current','future']);
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const fits=await scope.evaluate(element=>{const rect=element.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1;});assert.equal(fits,true);
  await noActions(frame);await scope.scrollIntoViewIfNeeded();await capture(page,'mobile-hostile-text.png');
  await frame.locator('.approval-trace-step').last().scrollIntoViewIfNeeded();
  const reachable=await frame.locator('.approval-trace-step').last().evaluate(element=>{const rect=element.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight+1;});assert.equal(reachable,true);
});
