import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupEntityMasterSecurity} from './fixtures/setup-entity-master-security.mjs';
const db=new PGlite();
before(async()=>{await setupEntityMasterSecurity(db);await db.exec(await readFile('supabase/migrations/20261112144158_customer_multiple_email_recipients.sql','utf8'));await db.exec(await readFile('supabase/migrations/20261112145357_preserve_customer_existing_assignments_on_edit.sql','utf8'));});after(()=>db.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function assume(user=1,role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);await db.exec('set role authenticated');}
const input=(extra={})=>({company_name:'Synthetic legacy customer',tax_id:'LEGACY-TEST',customer_type:'Empresa',email:'old@example.invalid',is_intercompany:false,applies_withholding:false,credit_limit:100,envio_estado_cuenta_auto:false,subsidiary_ids:[1],currency_ids:[1],withholding_rules:[],...extra});
const save=async(p,id=null)=>(await db.query("select save_entity_master('customers',$1,$2) result",[p,id])).rows[0].result;
const get=async id=>(await db.query("select entity_master_list('customers') result")).rows[0].result.find(r=>r.customer_id===id);
async function denied(p,id,code='42501'){await db.exec('savepoint denied');try{await assert.rejects(save(p,id),e=>e.code===code);}finally{await db.exec('rollback to savepoint denied');}}
async function legacy(){
 await assume();const row=await save(input());await db.exec('reset role');
 // Reproduce an existing shared customer with an additional subsidiary whose currency differs.
 await db.query("insert into entity_subsidiaries(customer_id,subsidiary_id,is_primary,credit_limit)values($1,2,false,100)",[row.customer_id]);
 await db.exec('delete from subsidiary_currencies where subsidiary_id=2;update subsidiaries set currency_id=2 where subsidiary_id=2');
 await assume();return get(row.customer_id);
}
test('editing email keeps legacy assignments and primary values even when checkbox order changes',async t=>{
 await tx(t);const row=await legacy();const changed=await save(input({subsidiary_ids:[2,1],email:'new@example.invalid;copy@example.invalid',_revision:row._revision}),row.customer_id);
 assert.equal(changed.email,'new@example.invalid, copy@example.invalid');assert.deepEqual(changed.subsidiary_ids,[1,2]);assert.deepEqual(changed.currency_ids,[1]);assert.equal(changed.primary_subsidiary_id,1);assert.equal(changed.currency_id,1);
 await denied(input({_revision:row._revision,subsidiary_ids:[1,2]}),row.customer_id,'55000');
});
test('new customers and changed assignments still require valid authorized subsidiaries and currencies',async t=>{
 await tx(t);const row=await legacy();await denied(input({subsidiary_ids:[1,2]}),null);await denied(input({_revision:row._revision,subsidiary_ids:[1,2],currency_ids:[1,999]}),row.customer_id);await denied(input({_revision:row._revision,subsidiary_ids:[1,2,999]}),row.customer_id);
 await assume(1,3);await denied(input({_revision:row._revision,subsidiary_ids:[1,2]}),row.customer_id);
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=2');await assume();await denied(input({_revision:row._revision,subsidiary_ids:[1,2]}),row.customer_id);
});
test('department and representative may belong to any selected authorized subsidiary',async t=>{
 await tx(t);await db.exec("insert into departments(department_id,name,type,subsidiary_id,is_inactive)values(991,'Synthetic department','Cliente',2,false);insert into employees(employee_id,first_name,last_name,subsidiary_id,is_active,is_sales_representative)values(991,'Synthetic','Representative',2,true,true)");await assume();
 const row=await save(input({subsidiary_ids:[1,2],currency_ids:[1,2],department_id:991,sales_representative_id:991}));assert.equal(row.department_id,991);assert.equal(row.sales_representative_id,991);
 await denied(input({department_id:991}),null);await denied(input({sales_representative_id:991}),null);
});
