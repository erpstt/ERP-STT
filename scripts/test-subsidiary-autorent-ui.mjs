import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function loadComponent(){
  let component;
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const storage={getItem(){return null},setItem(){},removeItem(){}};
  vm.runInNewContext(source,{
    createApp:options=>{component=options;return{config:{compilerOptions:{}},mount(){}}},
    initialWorkspace:()=>'',loadSubsidiaryApprovers:async()=>[],
    window:{matchMedia:()=>({matches:false}),addEventListener(){}},navigator:{connection:null},localStorage:storage,sessionStorage:storage,
    document:{createElement:()=>({}),head:{append(){}},getElementById:()=>({addEventListener(){}})},Intl,URL,Date,JSON,Number,String,Object,Array,Set,Map,Math,crypto:{},console
  });
  return component;
}

function colombianApp(component){
  const data=component.data();
  return {
    ...data,...component.methods,
    activeCatalog:{slug:'subsidiaries',apiRoot:'organization',fields:[],primaryKey:'subsidiary_id'},
    recordDialog:{open:true,mode:'form',id:7,values:{country_id:57,applies_income_autorent:true,autorent_active_account_id:101,autorent_passive_account_id:201,autorent_percentage:0.011},label:'Colombia SAS'},
    autorentPercentInput:'1.10',autorentAccountSearch:{active:'',passive:''},
    referenceOptions:{
      'core/countries':[{country_id:57,country_code_iso2:'CO',country_code_iso3:'COL',name:'Colombia'},{country_id:188,country_code_iso2:'CR',name:'Costa Rica'}],
      'accounting/chart-accounts':[
        {account_id:101,account_number:'135515',account_name:'Anticipo Autorretención',financial_statement:'Balance General',category:'Activo',nature:'Deudora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[7]},
        {account_id:102,account_number:'135516',account_name:'Activo de otra sociedad',financial_statement:'Balance General',category:'Activo',nature:'Deudora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[8]},
        {account_id:103,account_number:'135517',account_name:'Activo inactivo',financial_statement:'Balance General',category:'Activo',nature:'Deudora',level:4,accepts_entries:true,is_inactive:true,subsidiary_ids:[7]},
        {account_id:104,account_number:'135518',account_name:'Activo en resultados',financial_statement:'Estado de Resultados',category:'Activo',nature:'Deudora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[7]},
        {account_id:201,account_number:'236575',account_name:'Autorretenciones por Pagar',financial_statement:'Balance General',category:'Pasivo',nature:'Acreedora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[7]},
        {account_id:202,account_number:'236576',account_name:'Pasivo sin movimientos',financial_statement:'Balance General',category:'Pasivo',nature:'Acreedora',level:3,accepts_entries:false,is_inactive:false,subsidiary_ids:[7]}
      ]
    }
  };
}

test('la tarjeta se limita a Colombia y ofrece las cuentas globales compatibles por categoría y naturaleza',async()=>{
  const component=await loadComponent(),app=colombianApp(component);
  assert.equal(app.isColombiaSelected(),true);
  assert.deepEqual(app.autorentAccounts('Activo','active').map(row=>row.account_id),[101,102]);
  assert.deepEqual(app.autorentAccounts('Pasivo','passive').map(row=>row.account_id),[201]);
  app.autorentAccountSearch.active='135515';
  assert.deepEqual(app.autorentAccounts('Activo','active').map(row=>row.account_id),[101]);
  app.recordDialog.values.country_id=188;
  app.handleFieldChange({key:'country_id'});
  assert.equal(app.isColombiaSelected(),false);
  assert.equal(app.recordDialog.values.applies_income_autorent,false);
  assert.equal(app.recordDialog.values.autorent_active_account_id,null);
});

test('muestra 1,10 por ciento y persiste el factor contable 0.0110',async()=>{
  const component=await loadComponent(),app=colombianApp(component);
  assert.equal(app.autorentPercentageDisplay(0.011),'1,10');
  let saved;
  app.api=async(_path,init)=>{saved=JSON.parse(init.body);return saved};
  app.loadCatalog=async()=>{};
  await app.submitRecord();
  assert.equal(app.dialogError,'');
  assert.equal(saved.autorent_percentage,0.011);
  assert.equal(saved.autorent_active_account_id,101);
  assert.equal(saved.autorent_passive_account_id,201);
});

test('la plantilla presenta pestañas, una sección condicional y ayuda contable',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/class="subsidiary-form-tabs"/);
  assert.match(html,/subsidiaryFormTab==='tax' && isColombiaSelected\(\)/);
  assert.match(html,/¿Practica Autorretención de Renta\?/);
  assert.match(html,/autorent_active_account_id/);
  assert.match(html,/autorent_passive_account_id/);
  assert.match(html,/factor contable 0,0110/);
  assert.match(html,/El total de la factura y la cuenta por cobrar permanecen intactos/);
});
