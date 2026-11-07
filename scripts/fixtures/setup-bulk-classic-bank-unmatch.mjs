import {readFile}from'node:fs/promises';
import {setupClassicBankUnmatch}from'./setup-classic-bank-unmatch.mjs';
export {assumeSecurityUser,assumeSqlRole,deniedSql}from'./setup-classic-bank-unmatch.mjs';
export const bulkClassicBankUnmatchMigration='20261107211240_add_atomic_classic_bank_unmatch_all.sql';
export async function applyBulkClassicBankUnmatch(db){const sql=(await readFile(new URL('../../supabase/migrations/'+bulkClassicBankUnmatchMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');await db.exec('begin');try{await db.exec(sql);await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}}
export async function setupBulkClassicBankUnmatch({apply=true}={}){const fixture=await setupClassicBankUnmatch();try{if(apply)await applyBulkClassicBankUnmatch(fixture.db);return fixture;}catch(error){await fixture.db.close();throw error;}}
export async function seedBulkClassicMatches(db,{count=11,secondaryCount=1}={}){
 await db.exec('reset role');
 if(!Number.isSafeInteger(count)||count<0||secondaryCount<0||secondaryCount>count)throw Error('Invalid synthetic bulk fixture');
 await db.exec("insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed)values(11,1,'2026-11-01','2026-11-30',false)");
 const first=(await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-10-31',1,10,'ABIERTA')returning reconciliation_id")).rows[0].reconciliation_id;
 const second=secondaryCount?(await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-11-03',1,11,'ABIERTA')returning reconciliation_id")).rows[0].reconciliation_id:null;
 await db.query("insert into bank_statement_line(statement_id,bank_date,reference,amount,source_row,reconciliation_status)select 1,'2026-10-15','SYNTHETIC-BULK-'||n,25+n::numeric/1000,1000+n,'CONCILIADO'from generate_series(1,$1)n",[count]);
 await db.query("insert into bank_transaction(bank_account_id,tran_date,value_date,amount,tran_type,reference_number,reconciliation_status)select 1,'2026-10-15','2026-10-17',25+n::numeric/1000,'SYNTHETIC','SYNTHETIC-BULK-'||n,'CONCILIADO'from generate_series(1,$1)n",[count]);
 await db.query("insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)select case when l.source_row>1000+$1-$2 then $4::bigint else $3::bigint end,b.bank_tran_id,l.statement_line_id,'MANUAL',1 from bank_statement_line l join bank_transaction b on b.reference_number=l.reference where l.statement_id=1 and l.source_row>1000 order by l.source_row",[count,secondaryCount,first,second]);
 await db.exec('update bank_statement set closing_balance=opening_balance+(select sum(amount)from bank_statement_line where statement_id=1)where statement_id=1');
 const matches=(await db.query('select m.match_id,m.bank_tran_id,m.statement_line_id,m.reconciliation_id from bank_reconciliation_match m join bank_statement_line l using(statement_line_id)where l.statement_id=1 order by m.match_id')).rows;
 return{bank:1,cutoff:'2026-10-31',statement:1,first,second,matches};
}
