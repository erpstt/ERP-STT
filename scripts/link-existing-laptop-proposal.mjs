import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
// Specific historical match requested by the user: proposal 1 -> ACT-000001 (asset 4).
const commit=process.argv.includes('--commit');
try{
 await db.query('begin');
 await db.query("set local lock_timeout='5s';set local statement_timeout='30s'");
 const {rows:[context]}=await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email) order by selected_at desc limit 1');
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const {rows:[{sid}]}=await db.query('select fixed_asset_proposal_access(true) sid');assert.equal(String(sid),'3','La subsidiaria activa cambi?.');
 await db.query('select 1 from activos_fijos_propuestas where proposal_id=1 for update');
 await db.query('select 1 from asset where asset_id=4 for update');
 const {rows:[match]}=await db.query(`select p.status,p.source_number,p.invoice_number,a.asset_number,
 p.subsidiary_id=a.subsidiary_id and a.subsidiary_id=3 and p.account_id=c.asset_account_id and p.amount_local=a.purchase_cost and p.source_date=a.purchase_date and a.currency_id=s.currency_id and a.status='ACTIVO' exact_match,
 not exists(select 1 from fixed_asset_proposal_allocation where asset_id=4 or proposal_id=1) unlinked
 from activos_fijos_propuestas p cross join asset a join asset_category c using(category_id) join subsidiaries s on s.subsidiary_id=a.subsidiary_id where p.proposal_id=1 and a.asset_id=4`);
 assert.ok(match?.exact_match,'Los datos ya no coinciden.');assert.equal(match.status,'PENDIENTE');assert.ok(match.unlinked);assert.equal(match.invoice_number,'98464165');assert.equal(match.asset_number,'ACT-000001');
 const snapshot=async()=>{const {rows:[row]}=await db.query(`select (select to_jsonb(a)from asset a where asset_id=4) asset,
 (select coalesce(jsonb_agg(to_jsonb(d)order by depreciation_id),'[]')from asset_depreciation d where asset_id=4) depreciations,
 (select count(*)from journal) journal_count,(select count(*)from gl_impact) gl_count`);return row};
 const before=await snapshot();
 await db.query(`insert into fixed_asset_proposal_allocation(proposal_id,asset_id,amount_local,amount_foreign)select proposal_id,4,amount_local,amount_foreign from activos_fijos_propuestas where proposal_id=1`);
 await db.query(`update activos_fijos_propuestas set status='CAPITALIZADO',reason=$1,processed_at=now(),processed_by=app_user_id()where proposal_id=1`,['Vinculaci?n hist?rica solicitada por el usuario: factura 98464165 relacionada con ACT-000001, creado antes del motor de propuestas. Coinciden costo, cuenta y fecha de adquisici?n. Se conservan la ficha y sus depreciaciones; no se genera asiento adicional.']);
 const after=await snapshot();assert.deepEqual(after,before,'Se modificaron activos, depreciaciones o movimientos contables.');
 const {rows:[{result}]}=await db.query("select fixed_asset_proposal_report('{}') result");assert.equal(Number(result.reconciliation.difference),0);assert.equal(result.reconciliation.balanced,true);
 const {rows:[{origins}]}=await db.query('select fixed_asset_proposal_origins(4) origins');assert.equal(origins.length,1);assert.equal(origins[0].proposalId,1);
 await db.query(commit?'commit':'rollback');
 console.log(JSON.stringify({committed:commit,proposalId:1,invoice:match.invoice_number,asset:match.asset_number,depreciationsPreserved:before.depreciations.length,assetUnchanged:true,noNewPostings:true,reconciliation:result.reconciliation}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{await db.end()}
