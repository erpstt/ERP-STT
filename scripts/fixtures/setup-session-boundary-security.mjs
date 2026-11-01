import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{setupAccessAdminSecurity}from'./setup-access-admin-security.mjs';
export const expandMigration='20261101193641_secure_session_device_boundary.sql',activationMigration='20261101193756_activate_session_device_boundary_after_server.sql';
export const hash=s=>createHash('sha256').update(s).digest('hex');export const authId=u=>'00000000-0000-0000-0000-'+String(u).padStart(12,'0');export const authSession=u=>'11111111-0000-4000-8000-'+String(u).padStart(12,'0');
export async function setupSessionBoundarySecurity(db){await setupAccessAdminSecurity(db);await installSessionBoundarySecurity(db);}
export async function installSessionBoundarySecurity(db){await db.exec(`create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,created_at timestamptz default now());
create table devices(device_id bigint generated always as identity primary key,user_id bigint references users,device_name text,device_token text unique,last_used timestamptz);
create table sessions(session_id bigint generated always as identity primary key,user_id bigint references users,session_token text unique,ip_address inet,expires_at timestamptz,created_at timestamptz default now());
create table login_history(history_id bigint generated always as identity primary key,user_id bigint,login_time timestamptz default now(),ip_address inet,status text);
grant all on devices,sessions,login_history to authenticated,service_role;grant usage,select on all sequences in schema public to authenticated,service_role;
create policy unsafe_devices on devices for all to authenticated using(true)with check(true);
create policy unsafe_history on login_history for all to authenticated using(true)with check(true);`);
for(const n of[expandMigration,activationMigration])await db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
for(const u of[1,2,3,4]){await db.query('insert into auth.sessions(id,user_id)values($1,$2)',[authSession(u),authId(u)]);await db.exec('set role service_role');await db.query('select security_register_login($1,$2,$3,$4,$5,now()+interval\'1 hour\',null)',[authId(u),authSession(u),hash('jwt-'+u),hash('device-'+u),'Synthetic browser']);await db.exec('reset role');}}
