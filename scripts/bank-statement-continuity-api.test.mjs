import assert from 'node:assert/strict';
import {catalogPageResponse} from './lib/catalog-page-fixture.mjs';
import {test} from 'node:test';
import {getBankingCatalog,listBankingRows} from '../dist/modules/banking-catalogs/banking-catalogs.module.js';
import {reconciliationRpc} from '../dist/modules/banking-catalogs/bank-reconciliation-security.service.js';
import {bankReconciliationAction} from '../dist/modules/reports/accounting-reports.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-statement-continuity',origin='https://statement-continuity.example.invalid';
const originalFetch=globalThis.fetch,originalEnv={...process.env};
const resourceKey='banking:bank-statements';
test.beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY='public-continuity-fixture';
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey,canView:true,canCreate:true,canEdit:true,canDelete:true}]});
 globalThis.fetch=async()=>assert.fail('Unexpected provider request');
});
test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnv};invalidateRoleAccessCaches();});

test('los encabezados del extracto reflejan cambios de otro proceso sin caché de saldos',async()=>{
 let closing=23.67;const calls=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),headers=new Headers(init.headers);
  assert.equal(url.origin,origin);assert.equal(url.pathname,'/rest/v1/bank_statement');
  assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),'public-continuity-fixture');
  assert.equal(init.method??'GET','GET');calls.push(url.search);
  return catalogPageResponse([{statement_id:39,bank_account_id:6,statement_date:'2026-10-31',opening_balance:20895.66,closing_balance:closing}]);
 };
 const catalog=getBankingCatalog('bank-statements');
 assert.equal((await listBankingRows(catalog,auth))[0].closing_balance,23.67);
 closing=25.67;
 assert.equal((await listBankingRows(catalog,auth))[0].closing_balance,25.67);
 assert.equal(calls.length,2);
});

test('el listado fresco mantiene la autorización antes de consultar extractos',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;assert.fail('Denied request reached provider');};
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 await assert.rejects(listBankingRows(getBankingCatalog('bank-statements'),auth),error=>error.status===403);
 await assert.rejects(listBankingRows(getBankingCatalog('bank-statements'),''),error=>error.status===401);
 assert.equal(calls,0);
});

test('la importación legada sin archivo calcula el cierre con el mismo redondeo decimal de PostgreSQL',async()=>{
 for(const[amount,expected]of[[-1.005,-1.01],[1.005,1.01],[-2.675,-2.68],[2.675,2.68]]){
  let request;
  globalThis.fetch=async(input,init={})=>{
   assert.equal(new URL(String(input)).pathname,'/rest/v1/rpc/import_bank_statement');
   request=JSON.parse(init.body);return Response.json(71);
  };
  const result=await bankReconciliationAction(auth,'import',{p_bank_account_id:7,p_statement_date:'2026-10-31',p_opening_balance:0,p_lines:[{date:'2026-10-09',amount}]});
  assert.equal(result,71);assert.equal(request.p_closing_balance,expected);assert.equal(request.p_lines[0].amount,amount);
 }
});

test('los cuatro errores de continuidad tienen mensajes seguros y accionables sin reflejar SQL privado',async()=>{
 const cases=[['PBC01',422,/saldo inicial.*extracto anterior/],['PBC02',422,/saldo final.*movimientos/],['PBC03',422,/mes seleccionado/],['PBC04',409,/extracto posterior/]];
 for(const[code,status,message]of cases){
  globalThis.fetch=async()=>Response.json({code,message:'INTERNAL SQL detail: must never reach the user',details:'private provider detail',hint:'private provider hint'},{status:400});
  await assert.rejects(reconciliationRpc(auth,'import_bank_statement',{},resourceKey,'create'),error=>{
   assert.equal(error.status,status);assert.match(error.message,message);assert.doesNotMatch(error.message,/INTERNAL|SQL|private provider/);return true;
  });
 }
});

test('los errores de continuidad no sustituyen sesión, permisos ni protección de punteos',async()=>{
 for(const[http,code,status,message]of[[401,'PBC01',401,/sesión/],[403,'PBC02',403,/permiso/],[400,'55000',409,/punteos/],[400,'XX000',422,/Revise los datos/]]){
  globalThis.fetch=async()=>Response.json({code,message:'INTERNAL secret SQL detail'},{status:http});
  await assert.rejects(reconciliationRpc(auth,'import_bank_statement',{},resourceKey,'create'),error=>{
   assert.equal(error.status,status);assert.match(error.message,message);assert.doesNotMatch(error.message,/INTERNAL|secret SQL/);return true;
  });
 }
});
