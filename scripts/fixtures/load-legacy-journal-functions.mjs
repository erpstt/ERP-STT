import {readFile,readdir} from 'node:fs/promises';

// Load only repository function definitions and their renames, never migration data.
// Fixtures provide tables, numbering and GL projection; production triggers are not replayed.
export async function loadLegacyJournalFunctions(db){
 const dir=new URL('../../supabase/migrations/',import.meta.url);
 const selected=name=>/^(?:(?:create|update)_journal_entry(?:_|$)|reverse_journal_entry$|import_journal_csv(?:_|$)|journal_csv_(?:lookup|dimensions)$)/.test(name);
 for(const file of (await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;
  const sql=await readFile(new URL(file,dir),'utf8');
  const events=[];
  const definitions=/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi;
  for(const match of sql.matchAll(definitions))if(selected(match[1]))events.push({index:match.index,sql:match[0]});
  const renames=/alter\s+function\s+(?:public\.)?([a-z0-9_]+)\s*(\([^;]+?\))\s+rename\s+to\s+([a-z0-9_]+)\s*;/gi;
  for(const match of sql.matchAll(renames))if(selected(match[1])&&selected(match[3]))events.push({index:match.index,sql:match[0],from:match[1]+match[2],to:match[3]+match[2]});
  for(const event of events.sort((a,b)=>a.index-b.index)){
   if(event.from){const row=(await db.query('select to_regprocedure($1) source,to_regprocedure($2) target',[event.from,event.to])).rows[0];if(!row.source||row.target)continue;}
   await db.exec(event.sql);
  }
 }
}
