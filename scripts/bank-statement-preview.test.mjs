import assert from 'node:assert/strict';
import {test} from 'node:test';
import {previewBankStatement} from '../dist/modules/reports/bank-statement-preview.service.js';
import {bankReconciliationAction} from '../dist/modules/reports/accounting-reports.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer bank-statement-preview-fixture';
const originalFetch=globalThis.fetch,originalEnv={...process.env};
const line={date:'2026-10-03',valueDate:'',reference:'DEP-1',description:'Depósito',beneficiary:'Cliente',amount:25};
const input={p_bank_account_id:7,p_statement_date:'2026-10-31',p_file_name:'extracto.csv',p_file_text:'fecha,referencia,nota,beneficiario,monto,saldo_inicial\n2026-10-03,DEP-1,Depósito,Cliente,25,100\n'};
const noBalances={...input,p_file_text:'fecha,monto\n2026-10-03,50\n2026-10-12,-10\n'};
let options,calls;

async function grants(create=true,view=true){
  await primeRoleAccessCache(auth,{isAdmin:false,grants:[
    {resourceKey:'banking:bank-statements',canView:true,canCreate:create,canEdit:false,canDelete:false},
    {resourceKey:'reports:accounting-reports',canView:view,canCreate:false,canEdit:false,canDelete:false}
  ]});
}

test.beforeEach(async()=>{
  process.env.SUPABASE_URL='https://bank-preview.example.invalid';
  process.env.SUPABASE_ANON_KEY='public-bank-preview-fixture';
  options={accounts:[{id:7}],reconciliations:[]};calls=[];
  await grants();
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(String(url)).pathname,payload=JSON.parse(init.body||'{}'),headers=new Headers(init.headers);
    assert.equal(headers.get('authorization'),auth);
    assert.equal(headers.get('apikey'),'public-bank-preview-fixture');
    calls.push({path,payload});
    if(path==='/rest/v1/rpc/bank_reconciliation_options')return Response.json(options);
    if(path==='/rest/v1/rpc/import_bank_statement')return Response.json(71);
    assert.fail('Unexpected RPC: '+path);
  };
});
test.afterEach(()=>{
  globalThis.fetch=originalFetch;process.env={...originalEnv};invalidateRoleAccessCaches();
});

test('la vista previa exige creación de extractos y consulta de reportes antes de leer datos',async()=>{
  for(const [create,view]of[[false,false],[false,true],[true,false]]){
    await grants(create,view);
    await assert.rejects(previewBankStatement(auth,input),error=>error.status===403);
    assert.deepEqual(calls,[]);
  }
  await assert.rejects(previewBankStatement('',input),error=>error.status===401);
  assert.deepEqual(calls,[]);
});

test('la vista previa limita la cuenta a las opciones autorizadas y nunca importa',async()=>{
  await assert.rejects(previewBankStatement(auth,{...input,p_bank_account_id:8}),error=>error.status===403);
  assert.deepEqual(calls.map(call=>call.path),['/rest/v1/rpc/bank_reconciliation_options']);
  calls=[];
  const result=await previewBankStatement(auth,input);
  assert.equal(result.openingBalance,100);assert.equal(result.closingBalance,125);
  assert.deepEqual(result.lines,[line]);
  assert.deepEqual(calls,[{path:'/rest/v1/rpc/bank_reconciliation_options',payload:{}}]);
});

test('la importación recalcula el archivo e ignora saldos, movimientos y parámetros externos alterados',async()=>{
  const result=await bankReconciliationAction(auth,'import',{
    ...input,p_opening_balance:999999,p_closing_balance:-999999,
    p_lines:[{date:'2026-10-03',amount:999999}],p_subsidiary_id:999,p_admin:true
  });
  assert.equal(result,71);
  assert.deepEqual(calls,[
    {path:'/rest/v1/rpc/bank_reconciliation_options',payload:{}},
    {path:'/rest/v1/rpc/import_bank_statement',payload:{
      p_bank_account_id:7,p_statement_date:'2026-10-31',p_file_name:'extracto.csv',
      p_opening_balance:100,p_closing_balance:125,p_lines:[line]
    }}
  ]);
});

test('solo usa el cierre bancario del mes inmediatamente anterior y admite saldo cero',async()=>{
  for(const closing of[0,150,-50]){
    options.reconciliations=[{bankAccountId:7,date:'2026-09-30',status:'CERRADA',statementBalance:closing}];
    const result=await previewBankStatement(auth,noBalances);
    assert.equal(result.openingBalance,closing);assert.equal(result.closingBalance,closing+40);
    assert.equal(result.balanceSource,'PREVIOUS_RECONCILIATION');
  }
  assert.ok(calls.every(call=>call.path.endsWith('/bank_reconciliation_options')));
});

test('rechaza cierres viejos, ajenos, abiertos o sin saldo y movimientos anteriores al cierre',async()=>{
  const previous={bankAccountId:7,date:'2026-09-30',status:'CERRADA',statementBalance:150};
  for(const changed of[
    {date:'2026-08-31'},{bankAccountId:8},{status:'ABIERTA'},
    {statementBalance:null},{statementBalance:''},{statementBalance:'NaN'}
  ]){
    options.reconciliations=[{...previous,...changed}];
    await assert.rejects(previewBankStatement(auth,noBalances),error=>error.status===400&&/no incluye saldos/.test(error.message));
  }
  options.reconciliations=[previous];
  await assert.rejects(previewBankStatement(auth,{...noBalances,p_file_text:'fecha,monto\n2026-09-30,40\n'}),error=>error.status===400&&/no incluye saldos/.test(error.message));
  assert.ok(calls.every(call=>call.path.endsWith('/bank_reconciliation_options')));
});

test('los saldos del archivo tienen prioridad sobre el cierre anterior',async()=>{
  options.reconciliations=[{bankAccountId:7,date:'2026-09-30',status:'CERRADA',statementBalance:9999}];
  const result=await previewBankStatement(auth,input);
  assert.equal(result.openingBalance,100);assert.equal(result.closingBalance,125);
  assert.equal(result.balanceSource,'FILE_BALANCES');
});

test('rechaza fechas de conciliación inválidas antes de consultar opciones',async()=>{
  for(const cutoff of['','2026-02-30','2026-13-01','31/10/2026','2026-10-31T00:00:00Z']){
    await assert.rejects(previewBankStatement(auth,{...input,p_statement_date:cutoff}),error=>error.status===400);
  }
  assert.deepEqual(calls,[]);
});

test('rechaza movimientos o saldos OFX posteriores a la fecha de conciliación',async()=>{
  await assert.rejects(previewBankStatement(auth,{...input,p_file_text:'fecha,monto,saldo_inicial\n2026-11-01,25,100\n'}),error=>error.status===400&&/movimientos posteriores/.test(error.message));
  const ofx='<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>20261003<TRNAMT>25<FITID>DEP-1</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>125<DTASOF>20261101</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  await assert.rejects(previewBankStatement(auth,{...input,p_file_name:'extracto.ofx',p_file_text:ofx}),error=>error.status===400&&/saldo del extracto.*posterior/.test(error.message));
  assert.ok(calls.every(call=>call.path.endsWith('/bank_reconciliation_options')));
});
