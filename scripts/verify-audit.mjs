import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {isolatedAuditDatabase} from './fixtures/isolated-audit-test.mjs';

assertIsolatedTestArgs();

test('audit verification exercises the real capture lifecycle in an isolated in-memory database',async t=>{
 const db=await isolatedAuditDatabase();t.after(()=>db.close());
 await db.exec('create table synthetic_audit_verification(id bigint generated always as identity primary key,value text not null)');
 await db.query("select install_actor_audit('synthetic_audit_verification'::regclass)");
 const id=(await db.query("insert into synthetic_audit_verification(value)values('before')returning id")).rows[0].id;
 await db.query("update synthetic_audit_verification set value='after'where id=$1",[id]);
 const actor=(await db.query("select record_actor_audit('synthetic_audit_verification',$1)a",[String(id)])).rows[0].a;
 assert.equal(actor.created_by_email,'synthetic-1@example.invalid');assert.equal(actor.actor_type,'HUMAN');
 await db.query('delete from synthetic_audit_verification where id=$1',[id]);
 await db.query("select record_system_event('SYNTHETIC-VERIFICATION','fixture','Synthetic verification','EXITOSA','{\"test\":true}'::jsonb)");
 const counts=(await db.query("select(select count(*)::int from audit_log where entity_type='synthetic_audit_verification')audit_log,(select count(*)::int from change_log c join audit_log a on a.log_id=c.audit_log_id where a.entity_type='synthetic_audit_verification'and c.field_name='value')change_log,(select count(*)::int from event_log where event_type='SYNTHETIC-VERIFICATION')event_log,(select count(*)::int from activity_log where path_accessed like 'public.synthetic_audit_verification/%')activity_log,(select count(*)::int from deleted_records where original_table_name='synthetic_audit_verification')deleted_records")).rows[0];
 assert.deepEqual(counts,{audit_log:3,change_log:1,event_log:1,activity_log:3,deleted_records:1});
 const snapshot=JSON.parse((await db.query("select record_data_json from deleted_records where original_table_name='synthetic_audit_verification'")).rows[0].record_data_json);assert.equal(snapshot.value,'after');
 // No DROP of an existing application table and no network/credentials are used.
});
