import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await client.connect();
try {
  await client.query('begin');
  await client.query(await readFile(new URL('../supabase/migrations/20260908140000_subsidiary_approvers.sql',import.meta.url),'utf8'));
  if(process.argv.includes('--apply')) {
    await client.query('commit'); console.log('Subsidiary approvers migration applied.');
  } else {
    const context=(await client.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
    assert.ok(context);
    await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
    const sid=(await client.query('select active_subsidiary_id() sid')).rows[0].sid;
    const employee=(await client.query("insert into employees(first_name,last_name,identification,subsidiary_id,is_active) values('CSV','Approver test',$1,$2,true) returning employee_id",[`APPROVER-TEST-${Date.now()}`,sid])).rows[0];
    const employeeKey=`employee:${employee.employee_id}`;
    await client.query('set local role authenticated');
    const options=(await client.query('select * from subsidiary_approver_options where is_active')).rows;
    assert.ok(options.some(row=>row.approver_id===employeeKey));
    assert.ok(options.every(row=>Object.keys(row).sort().join(',')==='approver_id,is_active,name'));
    const user=options.find(row=>row.approver_id.startsWith('user:'));assert.ok(user);
    await client.query('update subsidiaries set project_approver=$1,administrative_approver=$2 where subsidiary_id=$3',[employeeKey,user.approver_id,sid]);
    const saved=(await client.query('select project_approver,administrative_approver from subsidiaries where subsidiary_id=$1',[sid])).rows[0];
    assert.equal(saved.project_approver,employeeKey);assert.equal(saved.administrative_approver,user.approver_id);
    for(const invalid of ['employee:999999999999','user:999999999999','plain text','user:abc']) {
      await client.query('savepoint bad');
      await assert.rejects(client.query('update subsidiaries set project_approver=$1 where subsidiary_id=$2',[invalid,sid]));
      await client.query('rollback to savepoint bad');
    }
    await client.query('reset role');
    await client.query('savepoint delete_assigned');
    await assert.rejects(client.query('delete from employees where employee_id=$1',[employee.employee_id]),/aprobador/);
    await client.query('rollback to savepoint delete_assigned');
    await client.query('update employees set is_active=false where employee_id=$1',[employee.employee_id]);
    await client.query('set local role authenticated');
    // An existing inactive assignment can be retained during an unrelated edit.
    await client.query('update subsidiaries set project_approver=project_approver where subsidiary_id=$1',[sid]);
    await client.query('update subsidiaries set project_approver=null,administrative_approver=null where subsidiary_id=$1',[sid]);
    await client.query('savepoint inactive');
    await assert.rejects(client.query('update subsidiaries set project_approver=$1 where subsidiary_id=$2',[employeeKey,sid]),/inactivo/);
    await client.query('rollback to savepoint inactive');
    await client.query('reset role');
    await client.query('delete from employees where employee_id=$1',[employee.employee_id]);
    await client.query('rollback');
    console.log('OK: employee/user selection, persistence, clearing, invalid/inactive rejection, protected deletion and minimal directory fields. Test data rolled back.');
  }
} catch(error) { await client.query('rollback'); throw error; }
finally { await client.end(); }
