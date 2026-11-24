import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupEntityMasterSecurity} from './fixtures/setup-entity-master-security.mjs';
test('optimized supplier list preserves row data, revisions, subsidiary scope and action permissions',async()=>{
 const db=new PGlite();try{
 await setupEntityMasterSecurity(db);
 await db.exec(await readFile('scripts/supplier-master-list-performance.sql','utf8'));
 async function assume(role=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',1,$1)on conflict(session_id)do update set role_id=$1",[role]);await db.exec("insert into user_company_sessions values('fixture',1,1)on conflict(session_id)do update set subsidiary_id=1");await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);await db.exec('set role authenticated');}
 await assume();
 const input={company_name:'Proveedor de prueba',tax_id:'SYNTHETIC-SECONDARY',supplier_type:'Empresa',email:'supplier@example.invalid',is_intercompany:false,applies_withholding:false,subsidiary_ids:[1],currency_ids:[1],withholding_rules:[]};
 const saved=(await db.query("select save_entity_master('suppliers',$1,null)r",[input])).rows[0].r;
 for(const role of [1,3]){
 await assume(role);await db.exec('reset role');const expected=(await db.query("select entity_master_private.dto('suppliers',$1)r",[saved.supplier_id])).rows[0].r;await db.exec('set role authenticated');
 const result=(await db.query("select entity_master_list('suppliers')r")).rows[0].r;assert.deepEqual(result.find(r=>r.supplier_id===saved.supplier_id),expected);
 }
 await db.exec('reset role;set role anon');await assert.rejects(db.query("select entity_master_list('suppliers')"));
 }finally{await db.close();}
});
