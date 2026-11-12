import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupEntityMasterSecurity} from './fixtures/setup-entity-master-security.mjs';
import {parseCustomerEmailRecipients} from '../public/customer-email-recipients.js';
const db=new PGlite();
before(async()=>{
 await setupEntityMasterSecurity(db);
 // Synthetic queue entry isolates the actual recipient/status expression without scheduling messages.
 await db.exec(`create or replace function public.statement_enqueue(p_sid bigint,p_customer bigint,p_cutoff date,p_key text,p_note text default '',p_auto boolean default false) returns text language plpgsql as $f$declare snap jsonb:=jsonb_build_object('email',p_note);begin return case when coalesce(snap->>'email','')~'^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\\.[^[:space:]@,;<>]+$'then 'PENDIENTE'else 'ERROR_SIN_CORREO'end;end$f$`);
 await db.exec(await readFile('supabase/migrations/20261112144158_customer_multiple_email_recipients.sql','utf8'));
});after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(){await db.exec(`insert into user_role_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,role_id=1;insert into user_company_sessions values('fixture',1,1)on conflict(session_id)do update set user_id=1,subsidiary_id=1;select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","session_id":"fixture"}',false);set role authenticated`);}
const input=(extra={})=>({company_name:'Synthetic multi email',tax_id:'SYN-MULTI',customer_type:'Empresa',email:'one@example.invalid;Two@example.invalid,ONE@example.invalid',is_intercompany:false,applies_withholding:false,credit_limit:100,envio_estado_cuenta_auto:true,subsidiary_ids:[1],currency_ids:[1],withholding_rules:[],...extra});
test('SQL and application parsing agree for valid, malformed, duplicate and injected addresses',async t=>{
 await tx(t);for(const value of ['','one@example.invalid',' one@example.invalid;Two@example.invalid,ONE@example.invalid; ','one@example.invalid;bad','a@-b.invalid','one@example.invalid\nBcc: evil@example.invalid',Array.from({length:21},(_,i)=>`email${i}@example.invalid`).join(',')]){
  let expected;try{expected=parseCustomerEmailRecipients(value);}catch{expected=null;}const actual=(await db.query('select entity_master_private.customer_email_recipients($1) result',[value])).rows[0].result;assert.deepEqual(actual,expected,value);
 }
});
test('customer save normalizes the list while suppliers retain their single-address validation',async t=>{
 await tx(t);await assume();const saved=(await db.query('select save_entity_master($1,$2,null) result',['customers',input()])).rows[0].result;const rows=(await db.query("select entity_master_list('customers') result")).rows[0].result;assert.ok(rows.some(row=>row.email==='one@example.invalid, Two@example.invalid'));
 for(const [catalog,payload]of [['customers',input({email:'one@example.invalid;bad'})],['suppliers',{...input(),customer_type:undefined,credit_limit:undefined,envio_estado_cuenta_auto:undefined,supplier_type:'Empresa'}]]){
  await db.exec('savepoint invalid');await assert.rejects(db.query('select save_entity_master($1,$2,null)',[catalog,payload]),e=>e.code==='22023');await db.exec('rollback to savepoint invalid');
 }
 assert.equal((await db.query("select has_function_privilege('authenticated','entity_master_private.customer_email_recipients(text)','execute') result")).rows[0].result,false);
});
test('statement queue accepts a valid recipient list and rejects invalid lists',async t=>{
 await tx(t);for(const [value,status]of [['one@example.invalid;two@example.invalid','PENDIENTE'],['one@example.invalid;bad','ERROR_SIN_CORREO'],['','ERROR_SIN_CORREO']])assert.equal((await db.query("select statement_enqueue(1,1,'2026-11-12','fixture',$1,false) result",[value])).rows[0].result,status);
});
