import pg from 'pg';
process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT),database:'postgres',user:`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try {
  const user = await client.query('select user_id,email from public.users order by user_id limit 1');
  if (!user.rows[0]) throw new Error('No existe un usuario ERP para la prueba.');
  await client.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify({email:user.rows[0].email,sub:'audit-verification',session_id:'audit-verification'})]);
  await client.query(`select set_config('request.headers',$1,false)`,[JSON.stringify({'x-forwarded-for':'127.0.0.1'})]);
  await client.query('drop table if exists public.audit_verification');
  await client.query('create table public.audit_verification(id bigint generated always as identity primary key,value text not null)');
  await client.query(`select public.install_audit_trigger('public.audit_verification'::regclass)`);
  const inserted=await client.query(`insert into public.audit_verification(value) values('antes') returning id`);
  await client.query(`update public.audit_verification set value='despues' where id=$1`,[inserted.rows[0].id]);
  await client.query(`delete from public.audit_verification where id=$1`,[inserted.rows[0].id]);
  await client.query(`select public.record_system_event('PRUEBA_AUTOMATICA','auditoria','Verificación automática de eventos','EXITOSA',$1::jsonb)`,[JSON.stringify({test:true})]);
  const result=await client.query(`select
    (select count(*)::int from audit_log where entity_type='audit_verification') audit_log,
    (select count(*)::int from change_log c join audit_log a on a.log_id=c.audit_log_id where a.entity_type='audit_verification') change_log,
    (select count(*)::int from event_log where event_type='PRUEBA_AUTOMATICA') event_log,
    (select count(*)::int from activity_log where path_accessed like 'public.audit_verification/%') activity_log,
    (select count(*)::int from deleted_records where original_table_name='audit_verification') deleted_records`);
  await client.query('drop table public.audit_verification');
  console.log(JSON.stringify({verified:true,...result.rows[0]}));
} finally { await client.end(); }
