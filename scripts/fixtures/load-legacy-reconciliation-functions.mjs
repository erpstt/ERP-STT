import {readFile,readdir} from 'node:fs/promises';
export async function loadLegacyReconciliationFunctions(db){
 const dir=new URL('../../supabase/migrations/',import.meta.url);
 const selected=n=>n.startsWith('quadratic_')||['import_bank_statement','bank_reconciliation_options','run_bank_reconciliation_report','ensure_open_bank_reconciliation','auto_match_bank_reconciliation','match_bank_transaction','close_bank_reconciliation','bank_reconciliation_close_report','bank_reconciliation_close_report_before_opening_bank','bank_statement_account_options','bank_statement_in_active_subsidiary'].includes(n);
 for(const file of(await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;const sql=await readFile(new URL(file,dir),'utf8'),events=[];
  for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(selected(m[1]))events.push({index:m.index,sql:m[0]});
  for(const m of sql.matchAll(/alter\s+function\s+(?:public\.)?([a-z0-9_]+)\s*(\([^;]+?\))\s+rename\s+to\s+([a-z0-9_]+)\s*;/gi))if(selected(m[1])&&selected(m[3]))events.push({index:m.index,sql:m[0],from:m[1]+m[2],to:m[3]+m[2]});
  for(const e of events.sort((a,b)=>a.index-b.index)){if(e.from){const r=(await db.query('select to_regprocedure($1) a,to_regprocedure($2) b',[e.from,e.to])).rows[0];if(!r.a||r.b)continue;}await db.exec(e.sql);}
 }
}
