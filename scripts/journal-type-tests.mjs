import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
const apply=process.argv.includes('--apply');
try {
 await db.connect();await db.query('begin');
 const before=(await db.query(`select * from journal where journal_number in('ASI_DIA-00000017','ASI_PEN-00000001') and journal_type='Asientos Pendientes de Facturar'`)).rows;
 assert.equal(before.length,1);
 const old=before[0];
 const linesBefore=(await db.query('select * from journal_line where journal_id=$1 order by journal_line_id',[old.journal_id])).rows;
 const transactionBefore=(await db.query('select * from "transaction" where transaction_id=$1',[old.transaction_id])).rows[0];
 await db.query(await readFile(new URL('../supabase/migrations/20260913130000_fix_manual_journal_number_type.sql',import.meta.url),'utf8'));
 const after=(await db.query('select * from journal where journal_id=$1',[old.journal_id])).rows[0];
 assert.equal(after.journal_number,'ASI_PEN-00000001');
 for(const key of ['total_debit','total_credit','journal_date','transaction_id','journal_type','created_by_id','created_by_email','created_by_name','actor_type','actor_source','execution_context_id'])assert.deepEqual(after[key],old[key],key);
 assert.deepEqual((await db.query('select * from journal_line where journal_id=$1 order by journal_line_id',[old.journal_id])).rows,linesBefore);
 const transactionAfter=(await db.query('select * from "transaction" where transaction_id=$1',[old.transaction_id])).rows[0];
 assert.equal(transactionAfter.tran_number,after.journal_number);
 for(const key of ['total_amount','transaction_type_id','currency_id','subsidiary_id'])assert.deepEqual(transactionAfter[key],transactionBefore[key],key);
 await db.query('savepoint numbering_tests');
 for(const [type,prefix] of [['Asientos Pendientes de Facturar','ASI_PEN'],['Asiento de Nóminas','ASI_NOM'],['Asiento de Liquidación','ASI_LIQ'],['Estándar','ASI_DIA']]) {
   const a=(await db.query('select next_manual_journal_number($1,$2) n',[type,old.subsidiary_id])).rows[0].n;
   const b=(await db.query('select next_manual_journal_number($1,$2) n',[type,old.subsidiary_id])).rows[0].n;
   assert.ok(a.startsWith(prefix+'-'));assert.notEqual(a,b);
 }
 await db.query('rollback to savepoint numbering_tests');
 await db.query(apply?'commit':'rollback');
 console.log(JSON.stringify({passed:true,applied:apply,number:after.journal_number,amountsAndLinesUnchanged:true,creationAuditUnchanged:true,typesVerified:4}));
}catch(error){await db.query('rollback').catch(()=>{});console.error(error.message);process.exitCode=1;}finally{await db.end();}
