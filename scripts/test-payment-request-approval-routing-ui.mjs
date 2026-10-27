import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({channel:'chrome',headless:true});

async function verifyRoute({
  id,source,approverId,title,approver,description,
  state='PENDIENTE_APROBACION'
}){
  const page=await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),action=url.pathname.split('/').at(-1);
    let body={};
    if(action==='options')body={
      company:'S.T.T. HOLDINGS LIMITED',baseCurrencyId:1,userId:4,
      admin:true,canApprove:true,canExecute:true,
      currencies:[{id:1,name:'JMD'}],
      users:[{id:4,name:'Supervisor Tributario'}],
      suppliers:[],customers:[],employees:[],taxAgencies:[],departments:[],
      costCenters:[],accounts:[],banks:[],rates:[]
    };
    else if(action==='report')body=[];
    else if(action==='detail')body={
      header:{
        id,numero:`SOL_PAG-${id}`,estado:state,
        id_solicitante:7,tipo_solicitud:'OTROS',id_moneda:1,
        fecha_solicitud:'2026-10-27',fecha_pago_programada:'2026-10-30',
        concepto:'Pago de impuestos',total:100,version:3,
        assigned_approver_id:approverId,approval_route_source:source
      },
      lines:[],events:[]
    };
    else if(action==='supports')body=[];
    else if(url.pathname==='/api/audit/record-actor')body={events:[]};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  try{
    await page.goto('http://localhost:3000/payment-requests.css',{waitUntil:'domcontentloaded'});
    await page.setContent('<iframe id="app"></iframe>');
    const app=page.frames().find(frame=>frame!==page.mainFrame());
    await app.goto(`http://localhost:3000/payment-requests.html?id=${id}`);
    await app.waitForSelector('#detailUpApproverCard:not([hidden])');
    assert.equal(await app.locator('#detailApprovalTitle').textContent(),title);
    assert.equal(await app.locator('#detailUpApprover').textContent(),approver);
    assert.equal(await app.locator('#detailUpSource').textContent(),description);
    assert.equal(
      await app.locator('[data-transition="APPROVE"]').count(),
      state==='PENDIENTE_APROBACION'?1:0
    );
  }finally{
    await page.close();
  }
}

try{
  await verifyRoute({
    id:91,source:'TAX_SUPERVISOR',approverId:4,
    title:'SUPERVISIÓN TRIBUTARIA',approver:'Supervisor Tributario',
    description:'Supervisor tributario de la subsidiaria'
  });
  await verifyRoute({
    id:92,source:'ADMIN_FALLBACK',approverId:4,
    title:'APROBACIÓN ADMINISTRATIVA',approver:'Supervisor Tributario',
    description:'Administrador autorizado para esta subsidiaria'
  });
  await verifyRoute({
    id:93,source:'MIXED',approverId:4,
    title:'RUTA DE APROBACIÓN COMBINADA',approver:'Supervisor Tributario',
    description:'Aprobadores secuenciales según las dimensiones de las líneas'
  });
  await verifyRoute({
    id:94,source:'MIXED',approverId:null,state:'APROBADO',
    title:'RUTA DE APROBACIÓN COMBINADA',approver:'Ruta finalizada',
    description:'Sin aprobación pendiente'
  });
  console.log(JSON.stringify({
    passed:true,taxSupervisorRoute:true,administratorFallbackRoute:true,
    mixedSequentialRoute:true,completedRouteLabel:true
  }));
}finally{
  await browser.close();
}
