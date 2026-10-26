import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15_000});
const sql=await readFile(new URL('../supabase/migrations/20261026110000_secure_user_auth_invitations.sql',import.meta.url),'utf8');
const authId=crypto.randomUUID(),state='a'.repeat(64),email='b'.repeat(64);
await db.connect();
try{
  await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='60s'");await db.query(sql);
  const columns=(await db.query("select column_name from information_schema.columns where table_schema='public'and table_name='users'and column_name=any(array['auth_user_id','invitation_sent_at','invitation_accepted_at']) order by column_name")).rows.map(row=>row.column_name);assert.deepEqual(columns,['auth_user_id','invitation_accepted_at','invitation_sent_at']);
  const privileges=(await db.query("select has_table_privilege('anon','public.user_invitation_grants','select') anon_select,has_table_privilege('authenticated','public.user_invitation_grants','select') authenticated_select,has_table_privilege('service_role','public.user_invitation_grants','select,insert,update,delete') service_access")).rows[0];assert.equal(privileges.anon_select,false);assert.equal(privileges.authenticated_select,false);assert.equal(privileges.service_access,true);
  await db.query("insert into public.user_invitation_grants(email_hash,state_hash,auth_user_id,expires_at)values($1,$2,$3,now()+interval'1 hour')",[email,state,authId]);await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);await db.query('set local role service_role');assert.equal((await db.query('select consume_user_invitation_grant($1,$2,$3) value',[state,email,authId])).rows[0].value,true);assert.equal((await db.query('select consume_user_invitation_grant($1,$2,$3) value',[state,email,authId])).rows[0].value,false);await db.query('reset role');
  console.log(JSON.stringify({migration:true,authLink:true,anonymousDenied:true,authenticatedDenied:true,serviceOnly:true,oneTimeInvitation:true,rollback:true}));
}finally{await db.query('reset role').catch(()=>{});await db.query('rollback').catch(()=>{});await db.end();}
