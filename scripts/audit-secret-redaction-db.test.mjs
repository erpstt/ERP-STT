import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {isolatedAuditDatabase} from './fixtures/isolated-audit-test.mjs';

assertIsolatedTestArgs();
let db;
before(async()=>{db=await isolatedAuditDatabase();});
after(async()=>{await db?.close();});
async function transaction(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}

test('historical audit redaction runs only in memory and preserves non-sensitive synthetic fields',async t=>{
 await transaction(t);
 await db.exec('alter table users add column password_hash text');
 const auditId=(await db.query("insert into audit_log(action,entity_type,entity_id,description)values('MODIFICACION','synthetic-redaction',991,'Synthetic history')returning log_id")).rows[0].log_id;
 const changeId=(await db.query("insert into change_log(audit_log_id,field_name,old_value,new_value)values($1,'password_hash','SYNTHETIC-OLD-SECRET','SYNTHETIC-NEW-SECRET')returning change_id",[auditId])).rows[0].change_id;
 const deletedId=(await db.query("insert into deleted_records(original_table_name,original_record_id,record_data_json,audit_log_id)values('synthetic-redaction',991,$1,$2)returning deleted_id",[JSON.stringify({name:'Visible',auth_user_id:'SYNTHETIC-UUID',nested:{api_token:'SYNTHETIC-TOKEN'}}),auditId])).rows[0].deleted_id;
 const invalidId=(await db.query("insert into deleted_records(original_table_name,original_record_id,record_data_json,audit_log_id)values('synthetic-invalid',992,'password=SYNTHETIC-INVALID-SECRET',$1)returning deleted_id",[auditId])).rows[0].deleted_id;
 const eventId=(await db.query("insert into event_log(event_type,source_component,description,details)values('SYNTHETIC','fixture','Synthetic history',$1::jsonb)returning event_id",[JSON.stringify({status:'visible',credentials:{password:'SYNTHETIC-PASSWORD'}})])).rows[0].event_id;
 const migration=await readFile(new URL('../supabase/migrations/20261026113000_redact_audit_secrets.sql',import.meta.url),'utf8');
 await db.exec(migration);
 assert.deepEqual((await db.query('select old_value,new_value from change_log where change_id=$1',[changeId])).rows[0],{old_value:'[REDACTADO]',new_value:'[REDACTADO]'});
 const deleted=JSON.parse((await db.query('select record_data_json from deleted_records where deleted_id=$1',[deletedId])).rows[0].record_data_json);
 assert.deepEqual(deleted,{name:'Visible',auth_user_id:'[REDACTADO]',nested:{api_token:'[REDACTADO]'}});
 const invalid=JSON.parse((await db.query('select record_data_json from deleted_records where deleted_id=$1',[invalidId])).rows[0].record_data_json);
 assert.deepEqual(invalid,{_reason:'FORMATO_HISTORICO_INVALIDO',_snapshot:'[REDACTADO]'});
 assert.deepEqual((await db.query('select details from event_log where event_id=$1',[eventId])).rows[0].details,{status:'visible',credentials:'[REDACTADO]'});
});

test('real capture and event functions redact future changes and deletion snapshots without a remote database',async t=>{
 await transaction(t);
 await db.exec('create table synthetic_redaction_probe(id bigint primary key,password_hash text,auth_user_id uuid,profile jsonb,note text)');
 await db.query("select install_actor_audit('synthetic_redaction_probe'::regclass)");
 await db.query("insert into synthetic_redaction_probe(id,password_hash,auth_user_id,profile,note)values(1,'SYNTHETIC-INITIAL-HASH','00000000-0000-4000-8000-000000000001',$1::jsonb,'Initial note')",[JSON.stringify({api_token:'SYNTHETIC-INITIAL-TOKEN',visible:'initial'})]);
 await db.query("update synthetic_redaction_probe set password_hash='SYNTHETIC-FINAL-HASH',auth_user_id='00000000-0000-4000-8000-000000000002',profile=$1::jsonb,note='Final note'where id=1",[JSON.stringify({api_token:'SYNTHETIC-FINAL-TOKEN',visible:'final'})]);
 const changes=(await db.query("select c.field_name,c.old_value,c.new_value from audit_log a join change_log c on c.audit_log_id=a.log_id where a.entity_type='synthetic_redaction_probe'and a.action='MODIFICACION'")).rows;
 const fields=Object.fromEntries(changes.map(c=>[c.field_name,c]));
 for(const field of ['password_hash','auth_user_id'])assert.deepEqual([fields[field].old_value,fields[field].new_value],['[REDACTADO]','[REDACTADO]']);
 assert.deepEqual([fields.note.old_value,fields.note.new_value],['Initial note','Final note']);
 assert.equal(JSON.parse(fields.profile.old_value).api_token,'[REDACTADO]');assert.equal(JSON.parse(fields.profile.new_value).api_token,'[REDACTADO]');assert.equal(JSON.parse(fields.profile.new_value).visible,'final');
 await db.exec('delete from synthetic_redaction_probe where id=1');
 const snapshot=JSON.parse((await db.query("select record_data_json from deleted_records where original_table_name='synthetic_redaction_probe'order by deleted_id desc limit 1")).rows[0].record_data_json);
 assert.equal(snapshot.password_hash,'[REDACTADO]');assert.equal(snapshot.auth_user_id,'[REDACTADO]');assert.equal(snapshot.profile.api_token,'[REDACTADO]');assert.equal(snapshot.profile.visible,'final');assert.equal(snapshot.note,'Final note');
 const eventId=(await db.query("select record_system_event('SYNTHETIC','fixture','Synthetic future event','EXITOSA',$1::jsonb)id",[JSON.stringify({result:'visible',resetToken:'SYNTHETIC-RESET',nested:{private_key:'SYNTHETIC-PRIVATE'}})])).rows[0].id;
 assert.deepEqual((await db.query('select details from event_log where event_id=$1',[eventId])).rows[0].details,{result:'visible',resetToken:'[REDACTADO]',nested:{private_key:'[REDACTADO]'}});
 const privileges=(await db.query("select has_function_privilege('authenticated','audit_field_is_sensitive(text)','EXECUTE')field_check,has_function_privilege('authenticated','audit_redact_jsonb(jsonb)','EXECUTE')json_redaction")).rows[0];
 assert.deepEqual(privileges,{field_check:false,json_redaction:false});
});
