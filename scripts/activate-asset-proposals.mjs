import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('begin');
 await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
 await db.query("select pg_advisory_xact_lock(hashtextextended('activate-fixed-asset-proposals',0))");
 const {rows:[state]}=await db.query("select to_regclass('public.activos_fijos_propuestas') is not null installed");
 if(!state.installed)await db.query(await readFile(new URL('../supabase/migrations/20260917140000_fixed_asset_capitalization_proposals.sql',import.meta.url),'utf8'));
 const {rows:[checks]}=await db.query("select to_regprocedure('public.fixed_asset_proposal_report(jsonb)') is not null report, to_regprocedure('public.process_fixed_asset_proposals(jsonb)') is not null process, to_regprocedure('public.fixed_asset_proposal_origins(bigint)') is not null origins, (select count(*)::int from pg_trigger where not tgisinternal and tgname in ('capture_fixed_asset_line','capture_fixed_asset_header','capture_fixed_asset_gl')) triggers");
 if(!checks.report||!checks.process||!checks.origins||checks.triggers!==3)throw Error('La instalación no contiene todas las funciones y disparadores esperados.');
 await db.query('commit');
 await db.query('begin');
 const {rows:[context]}=await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email) order by selected_at desc limit 1');
 if(!context)throw Error('Migración aplicada, pero no hay una sesión para verificar la bandeja.');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const {rows:[{result}]}=await db.query("select fixed_asset_proposal_report('{}') result");
 console.log(JSON.stringify({activated:true,alreadyInstalled:state.installed,checks,reportAvailable:true,proposals:result.rows.length,canManage:result.options.canManage,hasPrimaryBook:result.reconciliation.hasPrimaryBook,balanced:result.reconciliation.balanced,difference:result.reconciliation.difference}));
 await db.query('rollback');
}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{await db.end()}
