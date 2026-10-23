import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
 host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
 port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
 user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
 password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},
 application_name:'gentia_test_opening_balance_post_performance'
});
const migration=await readFile(new URL(
 '../supabase/migrations/20261023120000_optimize_opening_balance_post.sql',import.meta.url
),'utf8');

const one=async(sql,params=[])=>(await db.query(sql,params)).rows[0];

await db.connect();
try{
 await db.query('begin');
 await db.query("set local lock_timeout='8s'; set local statement_timeout='120s'");
 await db.query(migration);
 await db.query(migration);

 const triggerDefinition=(await one(
  "select pg_get_functiondef('public.sync_journal_gl_impacts_trigger()'::regprocedure) definition"
 )).definition;
 assert.match(triggerDefinition,/app\.opening_balance_internal/i);
 assert.match(triggerDefinition,/perform\s+public\.sync_journal_gl_impacts/i);

 // The bypass must be narrow: an ordinary journal still calls the canonical
 // synchronization function, while the controlled opening flag leaves the
 // final set-based build to opening_balance_post/opening_balance_reverse.
 assert.doesNotMatch(triggerDefinition,/opening_balance_internal[\s\S]*return null/i);
 const postStack=(await one(`
  select string_agg(pg_get_functiondef(proc.oid),E'\n' order by proc.proname) definition
  from pg_proc proc join pg_namespace namespace on namespace.oid=proc.pronamespace
  where namespace.nspname='public'and proc.proname like'opening_balance_post%'
 `)).definition;
 assert.match(postStack,/set_config\('app\.opening_balance_internal','1',true\)/i);
 assert.match(postStack,/insert\s+into\s+(public\.)?gl_impact/i);

 const internalFunctions=(await db.query(`
  select proc.proname,pg_get_functiondef(proc.oid)definition
  from pg_proc proc join pg_namespace namespace on namespace.oid=proc.pronamespace
  where namespace.nspname='public'
   and pg_get_functiondef(proc.oid)ilike'%app.opening_balance_internal%'
  order by proc.proname
 `)).rows;
 assert.ok(internalFunctions.length>0,'No se encontró el contrato interno de apertura.');
 for(const routine of internalFunctions){
  if(/insert\s+into\s+(?:public\.)?journal_line/i.test(routine.definition)){
   assert.match(routine.definition,/insert\s+into\s+(?:public\.)?gl_impact/i,
    `${routine.proname} difiere journal_line pero no genera el impacto definitivo.`);
  }
 }

 const fixture=await one(`
  select run.id,run.subsidiary_id,
   (select count(*)::integer from public.opening_balance_lines line where line.run_id=run.id) line_count
  from public.opening_balance_runs run
  where run.status='VALIDATED'
   and abs(coalesce((public.opening_balance_effective_summary(run.id)->>'difference')::numeric,
     (select sum(line.local_debit-line.local_credit)from public.opening_balance_lines line where line.run_id=run.id),0))<=.005
  order by run.id desc limit 1
 `);

 let live=null;
 if(fixture){
  const context=await one(`
   select users.email,session.session_id,auth_user.id sub,'authenticated' role
   from public.user_company_sessions session join public.users users using(user_id)
   join auth.users auth_user on lower(auth_user.email)=lower(users.email)
   join public.user_role_sessions role_session using(session_id,user_id)
   join public.roles role using(role_id)
   where session.subsidiary_id=$1
    and lower(role.role_name)in('administrador','administrator','admin')
   order by session.selected_at desc limit 1
  `,[fixture.subsidiary_id]);
  if(context){
   await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
   const before=await one(`
    select
     (select count(*)::integer from public.journal where is_opening_balance) journals,
     (select count(*)::integer from public.invoice where opening_run_id=$1) ar,
     (select count(*)::integer from public.supplier_invoice where opening_run_id=$1) ap
   `,[fixture.id]);

   await db.query('savepoint performance_post');
   await db.query("set local statement_timeout='8s'");
   const started=performance.now();
   const posted=(await one('select public.opening_balance_post($1)value',[fixture.id])).value;
   const elapsedMs=Math.round(performance.now()-started);
   assert.ok(posted?.journalId,'La contabilización no devolvió el asiento.');
   const result=await one(`
    select run.status,journal.transaction_id,
     (select count(*)::integer from public.journal_line where journal_id=journal.journal_id) journal_lines,
     (select count(*)::integer from public.gl_impact where transaction_id=journal.transaction_id) impacts
    from public.opening_balance_runs run join public.journal journal on journal.journal_id=run.journal_id
    where run.id=$1
   `,[fixture.id]);
   assert.equal(result.status,'POSTED');
   assert.equal(Number(result.journal_lines),Number(result.impacts),
    'El impacto definitivo no conserva una fila por línea de apertura.');
   assert.ok(Number(result.journal_lines)>0);

   // A savepoint rollback proves the RPC remains atomic: no header, document
   // or auxiliary survives if the surrounding statement/transaction fails.
   await db.query('rollback to savepoint performance_post');
   await db.query("set local statement_timeout='120s'");
   const after=await one(`
    select
     (select status from public.opening_balance_runs where id=$1) status,
     (select count(*)::integer from public.journal where is_opening_balance) journals,
     (select count(*)::integer from public.invoice where opening_run_id=$1) ar,
     (select count(*)::integer from public.supplier_invoice where opening_run_id=$1) ap
   `,[fixture.id]);
   assert.equal(after.status,'VALIDATED');
   assert.equal(after.journals,before.journals);
   assert.equal(after.ar,before.ar);
   assert.equal(after.ap,before.ap);
   live={runId:fixture.id,lines:fixture.line_count,elapsedMs,
    journalLines:Number(result.journal_lines),impacts:Number(result.impacts)};
  }
 }

 console.log(JSON.stringify({installed:true,
  internalRoutines:internalFunctions.map(routine=>routine.proname),live,rollback:true}));
 await db.query('rollback');
}catch(error){
 try{await db.query('rollback');}catch{}
 throw error;
}finally{
 await db.end();
}
