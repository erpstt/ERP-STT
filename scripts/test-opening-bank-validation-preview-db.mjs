import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
 ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15_000,
});
const migration=await readFile(new URL('../supabase/migrations/20261022160000_opening_bank_validation_preview.sql',import.meta.url),'utf8');
const one=async(text,params=[])=>(await db.query(text,params)).rows[0];

await db.connect();
try{
 await db.query('begin');
 await db.query("set local lock_timeout='8s'; set local statement_timeout='240s'");
 await db.query(migration);
 await db.query(migration); // The migration and wrapper must be rerunnable.

 const assertDefinition=(await one("select pg_get_functiondef('opening_bank_assert_reconciled(bigint)'::regprocedure)definition")).definition;
 const validateDefinition=(await one("select pg_get_functiondef('opening_balance_validate(jsonb)'::regprocedure)definition")).definition;
 const postingDefinitions=(await db.query(`select pg_get_functiondef(oid)definition from pg_proc
  where pronamespace='public'::regnamespace and proname like 'opening_balance_post%'`)).rows.map(row=>row.definition).join('\n');
 const activateDefinition=(await one("select pg_get_functiondef('opening_bank_activate(bigint)'::regprocedure)definition")).definition;

 assert.match(assertDefinition,/opening_bank_validation_preview/i);
 for(const field of ['ledgerAccountNumber','currency','bankCode','accountNumber','ledgerLocal','auxiliaryLocal','localDifference']){
  assert.match(assertDefinition,new RegExp(field,'i'),`El mensaje estricto debe incluir ${field}.`);
 }
 assert.match(validateDefinition,/set_config\('app\.opening_bank_validation_preview','1',true\)/i);
 assert.match(validateDefinition,/opening_balance_validate_before_bank_preview_details/i);
 assert.match(postingDefinitions,/opening_bank_assert_reconciled/i,'La contabilización debe conservar la validación estricta.');
 assert.match(activateDefinition,/opening_bank_assert_reconciled/i,'La activación bancaria debe conservar la validación estricta.');

 const fixture=await one(`select run.id run_id,run.subsidiary_id,session.session_id,app_user.user_id,app_user.email,auth_user.id auth_id
  from opening_balance_runs run
  join opening_bank_accounts opening_account on opening_account.run_id=run.id and opening_account.opening_reversed_at is null
  join opening_bank_items item on item.opening_bank_account_id=opening_account.id
  join user_company_sessions session on session.subsidiary_id=run.subsidiary_id
  join user_role_sessions role_session on role_session.session_id=session.session_id and role_session.user_id=session.user_id
  join roles role on role.role_id=role_session.role_id and lower(role.role_name)in('administrador','administrator','admin')
  join users app_user on app_user.user_id=session.user_id and app_user.is_active
  join auth.users auth_user on lower(auth_user.email)=lower(app_user.email)
  where run.status in('VALIDATED','POSTED')
  order by run.id desc,session.selected_at desc limit 1`);
 assert.ok(fixture,'Se requiere un lote validado con Auxiliar de Bancos y una sesión administradora.');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({
  sub:fixture.auth_id,email:fixture.email,session_id:fixture.session_id,role:'authenticated',
 })]);

 const baseline=(await one('select opening_bank_reconciliation($1)value',[fixture.run_id])).value;
 assert.ok(Array.isArray(baseline)&&baseline.length,'El lote de prueba debe devolver conciliación bancaria.');
 assert.ok(baseline.every(row=>Math.abs(Number(row.difference))<.005&&Math.abs(Number(row.localDifference))<.005),
  'El lote base debe estar conciliado antes de provocar la diferencia.');

 const changedItem=await one(`select item.id from opening_bank_items item
  join opening_bank_accounts account on account.id=item.opening_bank_account_id
  where account.run_id=$1 and account.opening_reversed_at is null
   and item.record_type='SALDO_CONCILIADO'and item.original_amount>=0 and item.local_equivalent>=0
  order by item.id limit 1`,[fixture.run_id]);
 assert.ok(changedItem,'Se requiere un saldo bancario inicial para provocar la diferencia.');
 await db.query(`update opening_bank_items set original_amount=original_amount+1,local_equivalent=local_equivalent+1
  where id=$1`,[changedItem.id]);

 const mismatch=(await one('select opening_bank_reconciliation($1)value',[fixture.run_id])).value;
 const mismatchedRow=mismatch.find(row=>Math.abs(Number(row.difference))>=.005||Math.abs(Number(row.localDifference))>=.005);
 assert.ok(mismatchedRow,'La prueba debe producir una diferencia bancaria visible.');

 // Substitute only the wrapped validator inside this rollback-only test so the
 // public wrapper can be exercised without rebuilding the complete source files.
 await db.query(`create or replace function public.opening_balance_validate_before_bank_preview_details(p jsonb)
  returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
  declare run_key bigint:=(p->>'runId')::bigint;
  begin
   perform public.opening_bank_assert_reconciled(run_key);
   return public.opening_balance_preview(run_key);
  end$$`);
 const preview=(await one('select opening_balance_validate($1::jsonb)value',[JSON.stringify({runId:fixture.run_id})])).value;
 assert.equal(preview.bankSummary.balanced,false);
 assert.ok(preview.bankReconciliation.some(row=>String(row.ledgerAccountNumber)===String(mismatchedRow.ledgerAccountNumber)
  &&String(row.currency)===String(mismatchedRow.currency)&&Math.abs(Number(row.localDifference))>=.005));

 // The validation wrapper must clear its local exception after returning.
 assert.notEqual((await one("select current_setting('app.opening_bank_validation_preview',true)value")).value,'1');
 await db.query('savepoint strict_bank_check');
 let strictMessage='';
 try{await db.query('select opening_bank_assert_reconciled($1)',[fixture.run_id]);}
 catch(error){strictMessage=String(error.message||error);await db.query('rollback to savepoint strict_bank_check');}
 assert.ok(strictMessage,'La validación estricta debe rechazar el descuadre.');
 for(const expected of [mismatchedRow.ledgerAccountNumber,mismatchedRow.currency,mismatchedRow.bankCode,'Mayor','Auxiliar','Diferencia']){
  assert.match(strictMessage,new RegExp(String(expected).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));
 }

 const privileges=await one(`select
  has_function_privilege('authenticated','opening_balance_validate(jsonb)','execute')authenticated_validate,
  has_function_privilege('anon','opening_balance_validate(jsonb)','execute')anon_validate,
  has_function_privilege('authenticated','opening_balance_validate_before_bank_preview_details(jsonb)','execute')direct_inner`);
 assert.equal(privileges.authenticated_validate,true);
 assert.equal(privileges.anon_validate,false);
 assert.equal(privileges.direct_inner,false);

 console.log(JSON.stringify({
  previewReturned:true,postRemainsStrict:true,
  account:mismatchedRow.ledgerAccountNumber,currency:mismatchedRow.currency,
  ledger:Number(mismatchedRow.ledgerLocal),auxiliary:Number(mismatchedRow.auxiliaryLocal),
  difference:Number(mismatchedRow.localDifference),detailedStrictMessage:true,
 }));
}finally{
 await db.query('rollback').catch(()=>{});
 await db.end();
}
