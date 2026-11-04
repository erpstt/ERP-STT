import{readFile}from'node:fs/promises';
import{setupPaymentRequestSecurity}from'./setup-payment-request-security.mjs';
export const treasuryManagerExecutionMigration='20261104220524_allow_named_treasury_manager_payment_execution.sql';
const read=p=>readFile(new URL(p,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
export const treasuryManagerExecutionSql=()=>read('../../supabase/migrations/'+treasuryManagerExecutionMigration);

export async function setupTreasuryManagerExecution(db){
 await setupPaymentRequestSecurity(db);
 // Canonicalize only the reviewed helper so exact production MD5 guards also
 // work when the published fixture/migration files were checked out as CRLF.
 await db.exec("do $$begin execute replace(pg_get_functiondef('public.pr_can_execute()'::regprocedure),E'\\r\\n',E'\\n');end$$;");
 const batch=await read('../../supabase/migrations/20261031183944_secure_payment_batches.sql');
 const match=batch.match(/create or replace function public\.payment_batch_has_permission\([\s\S]*?end\$\$;/);
 if(!match)throw Error('Missing real batch permission helper');await db.exec(match[0]);
 await db.exec(`
 insert into roles(role_id,role_name,is_system_role)values(6,'Encargado de Tesorería',true),(7,'Encargado de Tesoreria',true),(8,'Encargado de Tesorería auxiliar',false),(9,'Synthetic batch executor',false);
 insert into user_roles(user_id,role_id)values(1,6),(1,7),(1,8),(1,9);
 insert into role_access_matrix values(6,'treasury:payment-requests',true,false,true,false),(7,'treasury:payment-requests',true,false,true,false),(8,'treasury:payment-requests',true,false,true,false),(9,'treasury:payment-requests',true,false,true,false);
 insert into permissions(code)values('TREASURY_PAYMENT_BATCH_EXECUTE')on conflict(code)do nothing;
 `);
}

export async function applyTreasuryManagerExecutionMigration(db){
 await db.exec('begin');try{await db.exec(await treasuryManagerExecutionSql());await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
