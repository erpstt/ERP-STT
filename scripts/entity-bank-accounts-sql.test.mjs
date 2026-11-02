import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupEntityBankAccounts,assumeBankActor,bankSnapshot} from './fixtures/setup-entity-bank-accounts.mjs';

const db=new PGlite();
let initial;
before(async()=>{initial=await setupEntityBankAccounts(db);});
after(()=>db.close());
const one=async(sql,p=[])=> (await db.query(sql,p)).rows[0]?.data;
const catalogs=['suppliers','employees','other-names'];
const pk={suppliers:'supplier_id',employees:'employee_id','other-names':'other_name_id'};
const input=(catalog,extra={})=>({
  ...(catalog==='suppliers'?{company_name:'Bank test supplier',tax_id:'BANK-SUPPLIER',supplier_type:'Empresa',subsidiary_ids:[1],currency_ids:[1],withholding_rules:[]}:
    catalog==='employees'?{identification:'BANK-EMPLOYEE',first_name:'Bank',last_name:'Employee',subsidiary_id:1}:
      {identification:'BANK-OTHER',name:'Bank test third party',subsidiary_id:1}),
  ...extra
});
const accounts={
  payment_beneficiary_name:'Bank beneficiary',payment_bank_id:501,payment_iban:'CR05015202001026284066',
  payment_account_number:'0000012345',payment_currency_id:1,secondary_payment_bank_id:502,
  secondary_payment_iban:'GB82WEST12345698765432',secondary_payment_account_number:'0000987654',
  secondary_payment_currency_id:1
};
const save=(catalog,p,id=null)=>catalog==='other-names'?one('select save_other_name($1,$2) data',[p,id]):
  one('select save_entity_master($1,$2,$3)data',[catalog,p,id]);
const options=catalog=>catalog==='other-names'?one('select other_name_options()data'):
  one('select entity_master_options($1)data',[catalog]);
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));await assumeBankActor(db);}
async function denied(run,code='42501'){
  await db.exec('savepoint denied');
  try{await assert.rejects(run,e=>e.code===code);}
  finally{await db.exec('rollback to denied;release denied');}
}
function assertAccounts(row,expected=accounts){for(const[k,v]of Object.entries(expected))assert.equal(row[k],v,k);}

test('migración agrega campos nullable sin cambiar registros ni IBAN principal legado de proveedores',async()=>{
  await db.exec('reset role');
  assert.deepEqual(await bankSnapshot(db),initial.before);
  const columns=(await db.query("select table_name,column_name,column_default,is_nullable from information_schema.columns where table_schema='public'and table_name in('suppliers','employees','other_names')and(column_name like 'secondary_payment_%'or column_name='payment_currency_id')")).rows;
  assert.equal(columns.length,15);
  assert.ok(columns.every(c=>c.column_default===null&&c.is_nullable==='YES'));
  assert.equal(await one("select character_maximum_length data from information_schema.columns where table_schema='public'and table_name='suppliers'and column_name='payment_iban'"),22);
});

test('los tres maestros crean y actualizan dos cuentas independientes con moneda y ceros iniciales',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    const created=await save(catalog,input(catalog,accounts));
    assertAccounts(created);
    const changed=await save(catalog,input(catalog,{...accounts,secondary_payment_account_number:'0000000099',_revision:created._revision}),created[pk[catalog]]);
    assertAccounts(changed,{...accounts,secondary_payment_account_number:'0000000099'});
    assert.notEqual(changed._revision,created._revision);
  }
});

test('formulario anterior y patches que omiten campos nuevos conservan ambas cuentas y moneda NULL legado',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    const created=await save(catalog,input(catalog,accounts));
    const legacyPayload=input(catalog,{payment_bank_id:501,payment_iban:accounts.payment_iban,payment_beneficiary_name:'Bank beneficiary',_revision:created._revision});
    const changed=await save(catalog,legacyPayload,created[pk[catalog]]);
    assertAccounts(changed);
    const cleared=await save(catalog,input(catalog,{payment_currency_id:null,secondary_payment_currency_id:null,_revision:changed._revision}),created[pk[catalog]]);
    assert.equal(cleared.payment_currency_id,null);
    assert.equal(cleared.secondary_payment_currency_id,null);
    assert.equal(cleared.secondary_payment_account_number,accounts.secondary_payment_account_number);
  }
});

test('datos bancarios vacíos y cuentas parciales son opcionales; borrar secundaria no altera principal',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    const created=await save(catalog,input(catalog));
    assert.equal(created.payment_currency_id,null);
    assert.equal(created.secondary_payment_bank_id,null);
    const partial=await save(catalog,input(catalog,{secondary_payment_bank_id:502,secondary_payment_currency_id:1,_revision:created._revision}),created[pk[catalog]]);
    assert.equal(partial.secondary_payment_bank_id,502);
    assert.equal(partial.secondary_payment_account_number,null);
    const both=await save(catalog,input(catalog,{...accounts,_revision:partial._revision}),created[pk[catalog]]);
    const cleared=await save(catalog,input(catalog,{secondary_payment_bank_id:null,secondary_payment_iban:null,secondary_payment_account_number:null,secondary_payment_currency_id:null,_revision:both._revision}),created[pk[catalog]]);
    for(const k of Object.keys(accounts).filter(k=>k.startsWith('payment_')))assert.equal(cleared[k],accounts[k]);
    assert.equal(cleared.secondary_payment_bank_id,null);
  }
});

test('cuenta o IBAN requiere banco; checksum, tipos y límites fallan antes de persistir',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    for(const invalid of [
      {payment_account_number:'000123'},{secondary_payment_account_number:'000456'},
      {payment_bank_id:501,payment_iban:'CR00000000000000000000'},
      {secondary_payment_bank_id:502,secondary_payment_iban:'GB00WEST12345698765432'},
      {payment_bank_id:501,payment_account_number:123},
      {secondary_payment_bank_id:502,secondary_payment_account_number:'x'.repeat(81)},
      {secondary_payment_bank_id:1.1},{payment_currency_id:true},
      {payment_beneficiary_name:{}},{payment_beneficiary_name:'x'.repeat(251)}
    ])await denied(()=>save(catalog,input(catalog,invalid)),'22023');
  }
});

test('referencias bancarias y monedas ajenas se deniegan; proveedor utiliza alcance de sus filiales asignadas',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    for(const invalid of[{payment_bank_id:99999},{secondary_payment_bank_id:99999},{payment_currency_id:33},{secondary_payment_currency_id:33}])
      await denied(()=>save(catalog,input(catalog,invalid)));
  }
  await db.exec('reset role;delete from subsidiary_currencies where subsidiary_id=1 and currency_id=2');
  await assumeBankActor(db);
  for(const catalog of ['employees','other-names'])
    await denied(()=>save(catalog,input(catalog,{payment_currency_id:2})));
  const supplier=await save('suppliers',input('suppliers',{subsidiary_ids:[1,2],currency_ids:[1,2],payment_currency_id:2,secondary_payment_currency_id:1}));
  assert.equal(supplier.payment_currency_id,2);
  assert.equal(supplier.currency_id,1,'La moneda bancaria no reemplaza la moneda comercial.');
});

test('referencias y cuentas opcionales en blanco se normalizan a NULL en formularios nuevos o anteriores',async t=>{
  await tx(t);
  const blank={payment_bank_id:'',payment_currency_id:'',payment_iban:'',payment_account_number:'',
    secondary_payment_bank_id:'',secondary_payment_currency_id:'',secondary_payment_iban:'',secondary_payment_account_number:''};
  for(const catalog of catalogs){
    const created=await save(catalog,input(catalog,blank));
    for(const key of Object.keys(blank))assert.equal(created[key],null,catalog+' '+key);
    const changed=await save(catalog,input(catalog,{...blank,_revision:created._revision}),created[pk[catalog]]);
    for(const key of Object.keys(blank))assert.equal(changed[key],null,catalog+' edit '+key);
  }
});

test('opciones protegidas entregan bancos y monedas mínimas de filial sin exponer datos de cuentas',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    const refs=(await options(catalog)).references;
    assert.ok(refs['banking/banks'].some(b=>b.bank_id===501));
    assert.deepEqual(Object.keys(refs['banking/banks'].find(b=>b.bank_id===501)).sort(),['bank_code','bank_id','bank_name','country_id']);
    assert.ok(refs['core/currencies'].some(c=>c.currency_id===1));
    assert.ok(!refs['core/currencies'].some(c=>c.currency_id===33));
  }
  await assumeBankActor(db,1,1,2);
  for(const catalog of ['employees','other-names']){
    const currencies=(await options(catalog)).references['core/currencies'];
    assert.ok(currencies.some(c=>c.currency_id===2));
    assert.ok(!currencies.some(c=>c.currency_id===1));
  }
});

test('lector, admin sin concesión, filial ajena, revisión obsoleta y DML directo conservan las guardas',async t=>{
  await tx(t);
  for(const catalog of catalogs){
    const created=await save(catalog,input(catalog,accounts));
    await denied(()=>save(catalog,input(catalog,{...accounts,_revision:'stale'}),created[pk[catalog]]),'55000');
    await assumeBankActor(db,1,3,1);
    await denied(()=>save(catalog,input(catalog,{...accounts,_revision:created._revision}),created[pk[catalog]]));
    await assumeBankActor(db,4,5,1);
    await denied(()=>save(catalog,input(catalog,{...accounts,_revision:created._revision}),created[pk[catalog]]));
    await assumeBankActor(db,1,1,2);
    await denied(()=>save(catalog,input(catalog,{...accounts,_revision:created._revision}),created[pk[catalog]]));
    await assumeBankActor(db);
    const table=catalog==='other-names'?'other_names':catalog;
    await denied(()=>db.query('update '+table+" set secondary_payment_account_number='FORGED'"));
  }
  await denied(()=>db.query('select entity_bank_private.normalize_accounts($1,array[1])',[accounts]));
});

test('proveedor conserva IBAN principal CR; secundaria y otros maestros aceptan IBAN internacional normalizado',async t=>{
  await tx(t);
  await denied(()=>save('suppliers',input('suppliers',{payment_bank_id:501,payment_iban:'GB82WEST12345698765432'})),'22023');
  for(const catalog of ['employees','other-names']){
    const created=await save(catalog,input(catalog,{payment_bank_id:501,payment_iban:'gb82 west 1234 5698 7654 32'}));
    assert.equal(created.payment_iban,'GB82WEST12345698765432');
  }
  const supplier=await save('suppliers',input('suppliers',{secondary_payment_bank_id:502,secondary_payment_iban:'gb82 west 1234 5698 7654 32'}));
  assert.equal(supplier.secondary_payment_iban,'GB82WEST12345698765432');
});
