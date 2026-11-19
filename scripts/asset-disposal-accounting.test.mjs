import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupAssetDisposalAccounting} from './fixtures/setup-asset-disposal-accounting.mjs';
const db=new PGlite();before(()=>setupAssetDisposalAccounting(db));after(()=>db.close());
async function assume(role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('disposal-test',1,$1) on conflict(session_id) do update set role_id=$1",[role]);await db.query("insert into user_company_sessions values('disposal-test',1,$1) on conflict(session_id) do update set subsidiary_id=$1",[sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'disposal-test'})]);await db.exec('set role authenticated');}
const sale={type:'DISPOSAL',request_id:'00000000-0000-4000-8000-000000000001',asset_id:1,date:'2026-10-31',disposal_type:'VENTA',sale_amount:500,note:'Synthetic disposal',customer_id:21,collection_account_id:101,currency_id:1,tax_code_id:1,invoice_reference:'EXT-TEST'};
const call=async(action,payload={})=>(await db.query('select fixed_asset_disposal_accounting($1,$2) r',[action,payload])).rows[0].r;
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();await call('SETTINGS',{loss_account_id:301,sale_loss_account_id:302,gain_account_id:303,impairment_account_id:304});}
async function denied(action,payload,code){await db.exec('savepoint denial');try{await assert.rejects(call(action,payload),e=>!code||e.code===code);}finally{await db.exec('rollback to savepoint denial;release savepoint denial');}}
async function cut(payload=sale){return call('CUT',{asset_id:payload.asset_id,date:payload.date});}
async function balanced(journalId){const r=(await db.query('select sum(debit) d,sum(credit) c,count(*) filter(where debit=0 and credit=0) zeros from journal_line where journal_id=$1',[journalId])).rows[0];assert.equal(Number(r.d),Number(r.c));assert.equal(r.zeros,0);}

test('preview requires cut; posting is balanced, atomic and idempotent, keeps BAJA',async t=>{
 await tx(t);let preview=await call('PREVIEW',sale);assert.equal(preview.canPost,false);assert.equal(Number(preview.cutDue),100);await denied('POST',sale,'55000');
 await cut();preview=await call('PREVIEW',sale);assert.equal(preview.canPost,true);assert.equal(Number(preview.bookValue),1100);assert.equal(Number(preview.taxAmount),95);
 const r=await call('POST',sale);assert.equal((await call('POST',sale)).id,r.id);await db.exec('reset role');await balanced(r.journalId);assert.equal((await db.query('select status from asset where asset_id=1')).rows[0].status,'BAJA');
 assert.equal((await db.query('select count(*) n from asset_disposal')).rows[0].n,1);
 const row=(await db.query('select disposal_type,transaction_id from asset_disposal')).rows[0];assert.equal(row.disposal_type,'VENTA');assert.ok(row.transaction_id);
});
test('sale gain and zero-result sale produce correct result lines',async t=>{
 await tx(t);await cut();const profit={...sale,sale_amount:1500};let preview=await call('PREVIEW',profit);assert.equal(Number(preview.gainLoss),400);assert.ok(preview.lines.some(x=>x.account_id===303&&Number(x.credit)===400));
 preview=await call('PREVIEW',{...sale,sale_amount:1100});assert.equal(Number(preview.gainLoss),0);assert.ok(!preview.lines.some(x=>[302,303].includes(x.account_id)));
});
test('non-sale loss and fully depreciated disposal omit zero lines',async t=>{
 await tx(t);await cut();const payload={...sale,disposal_type:'BAJA',sale_amount:0};let preview=await call('PREVIEW',payload);assert.ok(preview.lines.some(x=>x.account_id===301&&Number(x.debit)===1100));
 await db.exec('reset role');await db.exec("update asset_depreciation set depreciation_amount=1200,accumulated_depreciation=1200,disposal_cut_monthly=null,depreciated_months=12 where asset_id=1");await assume();preview=await call('PREVIEW',payload);assert.equal(preview.lines.length,2);const r=await call('POST',payload);await db.exec('reset role');await balanced(r.journalId);
});
test('impairment is removed with its own debit and balanced result',async t=>{
 await tx(t);await db.exec('reset role');await db.exec("insert into asset_impairment(impairment_id,asset_id,assessment_date,impairment_loss,transaction_id) values(1,1,'2026-10-01',200,1)");await assume();await cut();const preview=await call('PREVIEW',sale);assert.equal(Number(preview.impairment),200);assert.ok(preview.lines.some(x=>x.account_id===304&&Number(x.debit)===200));const r=await call('POST',sale);await db.exec('reset role');await balanced(r.journalId);
});
test('reversal preserves original, reactivates asset, and is idempotent',async t=>{
 await tx(t);await cut();const r=await call('POST',sale);const p={id:r.id,date:'2026-11-01',note:'Synthetic reversal'};const reversed=await call('REVERSE',p);assert.equal((await call('REVERSE',p)).journalId,reversed.journalId);await db.exec('reset role');await balanced(reversed.journalId);assert.equal((await db.query('select status from asset where asset_id=1')).rows[0].status,'ACTIVO');assert.equal((await db.query('select count(*) n from asset_disposal')).rows[0].n,1);
});
test('partial month uses calendar days and can be completed after reversal',async t=>{
 await tx(t);const payload={...sale,date:'2026-10-15'};await cut(payload);let preview=await call('PREVIEW',payload);assert.equal(Number(preview.accumulated),48.387097);assert.equal(Number(preview.cutDue),0);const r=await call('POST',payload);await call('REVERSE',{id:r.id,date:'2026-10-16',note:'Correction'});
 await db.query('select run_fixed_asset_depreciation($1,$2)',['2026-10-31',[1]]);await db.exec('reset role');const row=(await db.query('select sum(depreciation_amount) total,sum(depreciated_months) months from asset_depreciation where asset_id=1')).rows[0];assert.equal(Number(row.total),100);assert.equal(Number(row.months),1);
});
test('foreign sale uses date rate; missing rate and duplicate invoice are blocked',async t=>{
 await tx(t);await cut();await db.exec('reset role');await db.exec("insert into subsidiary_currencies values(1,2);insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate) values(2,1,'2026-10-31',2)");await assume();let preview=await call('PREVIEW',{...sale,currency_id:2});assert.equal(Number(preview.saleLocal),1000);assert.equal(Number(preview.taxAmount),190);await db.exec('reset role');await db.exec("insert into invoice values(1,1,'EXT-TEST')");await assume();await denied('POST',sale,'55000');
});
test('permissions, subsidiary boundaries and accounting failure do not mutate asset',async t=>{
 await tx(t);await cut();await assume(3);await denied('POST',sale,'42501');await denied('SETTINGS',{loss_account_id:301},'42501');await assume();await denied('POST',{...sale,customer_id:22},'42501');await denied('POST',{...sale,collection_account_id:104},'42501');await db.exec('reset role');await db.exec('delete from asset_disposal_settings');await assume();await denied('POST',sale,'42501');await db.exec('reset role');assert.equal((await db.query('select status from asset where asset_id=1')).rows[0].status,'ACTIVO');assert.equal((await db.query('select count(*) n from asset_disposal')).rows[0].n,0);
});
test('reports distinguish BAJA by sale; linked journal cannot be altered',async t=>{
 await tx(t);await cut();const r=await call('POST',sale);const report=(await db.query("select fixed_asset_report('{}') r")).rows[0].r;assert.equal(report.rows.find(x=>x.id===1).exitType,'Venta');const op=(await db.query("select fixed_asset_operation_report('{\"type\":\"DISPOSAL\"}') r")).rows[0].r;assert.equal(op.rows[0].accountingStatus,'CONTABILIZADA');await db.exec('reset role;savepoint guard');await assert.rejects(db.query('update journal set memo=$1 where journal_id=$2',['changed',r.journalId]),e=>e.code==='55000');await db.exec('rollback to savepoint guard');
});
test('failure updating asset rolls back journal, GL, operation and idempotency key together',async t=>{
 await tx(t);await cut();await db.exec('reset role');const before=(await db.query('select count(*) n from journal')).rows[0].n;
 await db.exec(`create function fixture_fail_disposal() returns trigger language plpgsql as $$begin if new.status='BAJA' then raise exception using errcode='55000',message='Synthetic posting failure';end if;return new;end$$;create trigger fixture_fail_disposal before update on asset for each row execute function fixture_fail_disposal();`);
 await assume();await denied('POST',sale,'55000');await db.exec('reset role');assert.equal((await db.query('select count(*) n from journal')).rows[0].n,before);assert.equal((await db.query('select count(*) n from asset_disposal')).rows[0].n,0);assert.equal((await db.query('select status from asset where asset_id=1')).rows[0].status,'ACTIVO');
 await db.exec('drop trigger fixture_fail_disposal on asset');await assume();assert.ok((await call('POST',sale)).journalId);
});
test('closed periods block posting and reversal; BAJA is excluded from later depreciation',async t=>{
 await tx(t);await cut();await db.exec('reset role');await db.exec('update fiscal_periods set is_closed=true where fiscal_period_id=10');await assume();await denied('POST',sale,'55000');await db.exec('reset role');await db.exec('update fiscal_periods set is_closed=false where fiscal_period_id=10');await assume();const r=await call('POST',sale);
 await db.query('select run_fixed_asset_depreciation($1,$2)',['2026-11-30',[1]]);await db.exec('reset role');assert.equal((await db.query("select count(*) n from asset_depreciation where asset_id=1 and depreciation_date>='2026-11-01'")).rows[0].n,0);await db.exec('update fiscal_periods set is_closed=true where fiscal_period_id=11');await assume();await denied('REVERSE',{id:r.id,date:'2026-11-01',note:'Closed reversal'},'55000');
});
test('public RPC rejects anonymous and legacy write aliases cannot bypass accounting',async t=>{
 await tx(t);await db.exec('reset role;set role anon');await denied('OPTIONS',{},'42501');await db.exec('reset role;set role authenticated;savepoint alias');await assert.rejects(db.query('select save_fixed_asset_operation_before_accounting($1,null)',[sale]),e=>e.code==='42501');await db.exec('rollback to savepoint alias');await assert.rejects(db.query("select delete_fixed_asset_operation_before_accounting('DISPOSAL',1)"),e=>e.code==='42501');
});
test('an invoice cannot later duplicate a sale already posted by the disposal module',async t=>{
 await tx(t);await cut();await call('POST',sale);await db.exec('reset role;savepoint duplicate_invoice');await assert.rejects(db.exec("insert into invoice values(1,1,'EXT-TEST')"),e=>e.code==='55000');await db.exec('rollback to savepoint duplicate_invoice');
});
test('generic accounting reversal cannot bypass the asset lifecycle',async t=>{
 await tx(t);await cut();const r=await call('POST',sale);await db.exec('reset role;savepoint generic_reversal');await assert.rejects(db.query("insert into journal(journal_number,journal_date,subsidiary_id,currency_id,exchange_rate,reversed_from_journal_id) values('BAD-REV','2026-10-31',1,1,1,$1)",[r.journalId]),e=>e.code==='55000');await db.exec('rollback to savepoint generic_reversal');
});
