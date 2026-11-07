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
let context,calls,rpcFailure;

async function grants(create=true,view=true){
  await primeRoleAccessCache(auth,{isAdmin:false,grants:[
    {resourceKey:'banking:bank-statements',canView:true,canCreate:create,canEdit:false,canDelete:false},
    {resourceKey:'reports:accounting-reports',canView:view,canCreate:false,canEdit:false,canDelete:false}
  ]});
}

test.beforeEach(async()=>{
  process.env.SUPABASE_URL='https://bank-preview.example.invalid';
  process.env.SUPABASE_ANON_KEY='public-bank-preview-fixture';
  context={bankAccountId:7,statementDate:'2026-10-31',previousDate:'2026-09-30',previousStatement:null};calls=[];rpcFailure=null;
  await grants();
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(String(url)).pathname,payload=JSON.parse(init.body||'{}'),headers=new Headers(init.headers);
    assert.equal(headers.get('authorization'),auth);
    assert.equal(headers.get('apikey'),'public-bank-preview-fixture');
    calls.push({path,payload});
    if(path==='/rest/v1/rpc/bank_statement_balance_context'){
      if(payload.p_bank_account_id!==7)return Response.json({code:'42501'},{status:403});
      if(rpcFailure)return Response.json(rpcFailure.body,{status:rpcFailure.status});
      return Response.json(context);
    }
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
  assert.deepEqual(calls.map(call=>call.path),['/rest/v1/rpc/bank_statement_balance_context']);
  calls=[];
  const result=await previewBankStatement(auth,input);
  assert.equal(result.openingBalance,100);assert.equal(result.closingBalance,125);
  assert.deepEqual(result.lines,[line]);
  assert.deepEqual(calls,[{path:'/rest/v1/rpc/bank_statement_balance_context',payload:{p_bank_account_id:7,p_statement_date:'2026-10-31'}}]);
});

test('la importación recalcula el archivo e ignora saldos, movimientos y parámetros externos alterados',async()=>{
  const result=await bankReconciliationAction(auth,'import',{
    ...input,p_opening_balance:999999,p_closing_balance:-999999,
    p_lines:[{date:'2026-10-03',amount:999999}],p_subsidiary_id:999,p_admin:true
  });
  assert.equal(result,71);
  assert.deepEqual(calls,[
    {path:'/rest/v1/rpc/bank_statement_balance_context',payload:{p_bank_account_id:7,p_statement_date:'2026-10-31'}},
    {path:'/rest/v1/rpc/import_bank_statement',payload:{
      p_bank_account_id:7,p_statement_date:'2026-10-31',p_file_name:'extracto.csv',
      p_opening_balance:100,p_closing_balance:125,p_lines:[line]
    }}
  ]);
});

test('usa el extracto contiguo aunque su conciliación esté abierta y admite saldo cero',async()=>{
  for(const closing of[0,150,-50]){
    context.previousStatement={id:37,date:'2026-09-30',closingBalance:closing,status:'ABIERTA'};
    const result=await previewBankStatement(auth,noBalances);
    assert.equal(result.openingBalance,closing);assert.equal(result.closingBalance,closing+40);
    assert.equal(result.balanceSource,'PREVIOUS_STATEMENT');assert.equal(result.openingBalanceSource,'PREVIOUS_STATEMENT');
    assert.equal(result.previousDate,'2026-09-30');
    assert.deepEqual(result.previousStatement,{id:37,date:'2026-09-30',closingBalance:closing});
  }
  assert.ok(calls.every(call=>call.path.endsWith('/bank_statement_balance_context')));
});

test('el primer período necesita evidencia del archivo y no asume saldo cero',async()=>{
  await assert.rejects(previewBankStatement(auth,noBalances),error=>error.status===400&&/no incluye saldos/.test(error.message));
  const result=await previewBankStatement(auth,input);
  assert.equal(result.openingBalance,100);assert.equal(result.closingBalance,125);
  assert.equal(result.previousStatement,null);assert.equal(result.previousDate,'2026-09-30');
  assert.equal(result.openingBalanceSource,'FILE_BALANCES');
});

test('contrasta el archivo con el antecedente y no fuerza silenciosamente un cierre distinto',async()=>{
  context.previousStatement={id:37,date:'2026-09-30',closingBalance:100};
  const result=await previewBankStatement(auth,input);
  assert.equal(result.openingBalance,100);assert.equal(result.closingBalance,125);
  assert.equal(result.balanceSource,'FILE_BALANCES');
  context.previousStatement.closingBalance=20895.66;
  await assert.rejects(previewBankStatement(auth,{...input,p_file_text:'fecha,monto,saldo\n2026-10-31,-20869.99,23.67\n'}),error=>error.status===400&&/2026-09-30.*Esperado: 25.67.*diferencia: -2.000000/.test(error.message));
  assert.ok(calls.every(call=>call.path.endsWith('/bank_statement_balance_context')));
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
  assert.ok(calls.every(call=>call.path.endsWith('/bank_statement_balance_context')));
});

test('rechaza movimientos de otro mes aunque el archivo declare saldos consistentes',async()=>{
  for(const text of[
    'fecha,monto,saldo_inicial\n2026-09-30,25,100\n',
    'fecha,monto,saldo\n2026-09-30,-2,98\n2026-10-01,27,125\n'
  ])await assert.rejects(previewBankStatement(auth,{...input,p_file_text:text}),error=>error.status===400&&/otro mes/.test(error.message));
});

test('comprueba mes contiguo en año bisiesto y cambio de año',async()=>{
  for(const [cutoff,previousDate]of[['2024-03-31','2024-02-29'],['2027-01-31','2026-12-31']]){
    context={bankAccountId:7,statementDate:cutoff,previousDate,previousStatement:{id:37,date:previousDate,closingBalance:0}};
    const result=await previewBankStatement(auth,{...noBalances,p_statement_date:cutoff,p_file_text:`fecha,monto\n${cutoff},1.005\n`});
    assert.equal(result.previousDate,previousDate);assert.equal(result.openingBalance,0);assert.equal(result.closingBalance,1.01);
  }
});

test('rechaza contexto ausente, alterado o no finito sin recurrir a opciones globales',async()=>{
  const valid={...context};
  for(const malformed of[
    null,[],{}, {...valid,bankAccountId:8},{...valid,statementDate:'2026-11-30'},
    {...valid,previousDate:'2026-08-31'},{...valid,previousStatement:undefined},
    ...[
      {id:0,date:'2026-09-30',closingBalance:100},
      {id:37,date:'2026-08-31',closingBalance:100},
      ...[null,'', '100', 'NaN',Infinity].map(closingBalance=>({id:37,date:'2026-09-30',closingBalance}))
    ].map(previousStatement=>({...valid,previousStatement}))
  ]){
    context=malformed;
    await assert.rejects(previewBankStatement(auth,input),error=>error.status===502&&/contexto del extracto/.test(error.message));
  }
  assert.ok(calls.every(call=>call.path.endsWith('/bank_statement_balance_context')));
});

test('si la RPC no está disponible no inventa un primer período ni importa',async()=>{
  rpcFailure={status:404,body:{code:'PGRST202'}};
  await assert.rejects(previewBankStatement(auth,input),error=>error.status===422);
  assert.deepEqual(calls.map(call=>call.path),['/rest/v1/rpc/bank_statement_balance_context']);
});
