import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),shared=await readFile(new URL('../public/bank-ui.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function setup(){
 const values=new Map([['nexo_token','synthetic-old'],['nexo_company','1'],['nexo_role','2'],['nexo_device_token','synthetic-device']]),storage={getItem:key=>values.get(key)??null},state={generation:'synthetic-generation'};
 const context={console,AbortController,window:{NexoSessionRenewal:{current:()=>state}},localStorage:storage,sessionStorage:{getItem:()=>null},alphabeticalCollator:new Intl.Collator('es'),cancelRateCatalogLoad(){},loadSubsidiaryApprovers:async()=>[],Error};
 vm.createContext(context);vm.runInContext(shared.replace(/^export /gm,''),context);
 const helpers=source.slice(source.indexOf('const fiscalCatalogLoads='),source.indexOf('function cancelRateCatalogLoad'));vm.runInContext(helpers,context);
 const extract=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)+from.length));
 const methods=extract('async loadBankingCatalog(catalog)','async loadCatalog()')+extract('async loadCatalog()','selectModule(module)');
 const ui=vm.runInContext(`({${methods}})`,context),catalog={slug:'bank-accounts',apiRoot:'banking',fields:[{key:'currency_id',reference:'core/currencies'},{key:'account_id',reference:'accounting/chart-accounts'}]};
 Object.assign(ui,{activeCatalog:catalog,activeCompany:{subsidiaryId:1},activeRole:{roleId:2},currentModule:'Bancos',currentSection:'Cuentas bancarias',referenceOptions:{},rows:[],catalogPath(){return '/api/core/legacy';},api:async path=>path.startsWith('/api/banking/')?[{company:1}]:[]});
 return{ui,catalog,values,state,context,extract};
}
test('catálogo bancario aplica sólo filas y referencias de la empresa/rol/slug vigente',async()=>{
 const{ui,catalog,values}=setup(),old=deferred(),current=deferred();let revision=0;
 ui.api=async path=>{const request=revision;await(request===0?old.promise:current.promise);return path.startsWith('/api/banking/')?[{company:request+1}]:[{owner:request+1}];};
 const first=ui.loadBankingCatalog(catalog);revision=1;ui.activeCompany={subsidiaryId:2};values.set('nexo_company','2');const second=ui.loadBankingCatalog(catalog);current.resolve();await second;old.resolve();await first;
 assert.equal(ui.rows[0].company,2);assert.equal(ui.referenceOptions['core/currencies'][0].owner,2);assert.equal(ui.tableLoading,false);
});
test('rotación JWT de la misma generación conserva carga bancaria correcta',async()=>{
 const{ui,catalog,values}=setup(),pending=deferred();ui.api=async()=>{await pending.promise;return[{valid:true}];};const load=ui.loadBankingCatalog(catalog);values.set('nexo_token','synthetic-renewed');pending.resolve();await load;assert.equal(ui.rows[0].valid,true);assert.equal(ui.tableLoading,false);
});
test('respuesta genérica antigua no reemplaza filas ni loading del destino bancario',async()=>{
 const{ui,catalog}=setup(),pending=deferred();ui.activeCatalog={slug:'legacy',apiRoot:'core',fields:[]};ui.api=()=>pending.promise;const load=ui.loadCatalog();ui.activeCatalog=catalog;ui.rows=[{currentBank:true}];ui.tableLoading=true;pending.resolve([{staleGeneric:true}]);await load;assert.equal(ui.rows[0].currentBank,true);assert.equal(ui.tableLoading,true);
});
test('referencias genéricas antiguas no contaminan el catálogo bancario',async()=>{
 const{ui,catalog}=setup(),pending=deferred();ui.activeCatalog={slug:'legacy',apiRoot:'core',fields:[{reference:'core/currencies'}]};ui.api=()=>pending.promise;const load=ui.loadReferenceOptions();ui.activeCatalog=catalog;ui.referenceOptions={'core/currencies':[{currentBank:true}]};pending.resolve([{staleGeneric:true}]);await load;assert.equal(ui.referenceOptions['core/currencies'][0].currentBank,true);
});
test('maestro banco: país filtra banco/subsidiaria y GL usa subsidiaria seleccionada',()=>{
 const{ui,context,extract}=setup();const methods=extract('chartAccountScopeIds(){','filteredReferenceOptions(field) {')+source.slice(source.indexOf('    filteredReferenceOptions(field) {'),source.indexOf('\n    handleFieldChange(',source.indexOf('    filteredReferenceOptions(field) {')));
 Object.assign(ui,vm.runInContext(`({${methods}})`,context));ui.referenceId=(_reference,row)=>row.account_id;ui.referenceChoiceLabel=(_field,row)=>row.name||row.account_name||'';ui.allowedCurrencyIds=[1,2];ui.recordDialog={values:{country_id:10,subsidiary_id:2},id:null};ui.referenceOptions={banks:[{bank_id:1,country_id:10,name:'Allowed'},{bank_id:2,country_id:20,name:'Foreign'}],'organization/subsidiaries':[{subsidiary_id:1,country_id:10,name:'Allowed'},{subsidiary_id:2,country_id:20,name:'Foreign'}],'accounting/chart-accounts':[{account_id:1,subsidiary_ids:[1],account_name:'Wrong company'},{account_id:2,subsidiary_ids:[2],account_name:'Allowed',accepts_entries:true},{account_id:3,subsidiary_ids:[2],account_name:'Inactive',is_inactive:true}]};
 assert.deepEqual(Array.from(ui.filteredReferenceOptions({reference:'banks',filterBy:'country_id'}),row=>row.bank_id),[1]);assert.deepEqual(Array.from(ui.filteredReferenceOptions({reference:'organization/subsidiaries',filterBy:'country_id'}),row=>row.subsidiary_id),[1]);assert.deepEqual(Array.from(ui.filteredReferenceOptions({key:'account_id',reference:'accounting/chart-accounts'}),row=>row.account_id),[2]);
 ui.referenceOptions['organization/subsidiaries'].push({subsidiary_id:3,country_id:10,name:'Other company'});
 assert.deepEqual(Array.from(ui.filteredReferenceOptions({reference:'organization/subsidiaries',filterBy:'country_id',activeSubsidiaryOnly:true}),row=>row.subsidiary_id),[1]);
});
test('primitivas bancarias conservan6dec, rechazan precisión excedente y cuantizan sólo tasa calculada',()=>{
 const{context}=setup();assert.equal(vm.runInContext("validBankAmount(parseBankAmount('12,345678'))",context),true);assert.equal(vm.runInContext("validBankAmount(parseBankAmount('12,3456789'))",context),false);assert.equal(vm.runInContext("Number.isNaN(parseBankAmount('12,3,4'))",context),true);assert.notEqual(vm.runInContext('bankAmountInput(NaN)',context),'0,00');assert.equal(vm.runInContext('bankRate(1/3)',context),0.3333333333);
});
test('CSV bancario parsea campos entre comillas sin omitir ni transformar identificaciones',()=>{
 const{context}=setup();const records=vm.runInContext('parseBankCsvRows("fecha;referencia;importe;cuenta\\n2026-11-05;\\"REF;with separator\\";12,345678;000005\\n")',context);assert.equal(records[1][1],'REF;with separator');assert.equal(records[1][2],'12,345678');assert.equal(records[1][3],'000005');assert.throws(()=>vm.runInContext('parseBankCsvRows("a;b\\n1;2;3")',context),/fila 2/);assert.throws(()=>vm.runInContext('parseBankCsvRows("a;b\\n1;\\"unclosed")',context),/sin cerrar/);
});
