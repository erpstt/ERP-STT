import {readFile,readdir} from 'node:fs/promises';
// Replay function definitions only; never historical production-data statements.
export async function loadLegacyAssetPostingFunctions(db){
 const dir=new URL('../../supabase/migrations/',import.meta.url);
 const names=new Set(['assign_fixed_asset_number','validate_fixed_asset_local_currency','fixed_asset_options','save_fixed_asset','fixed_asset_period_depreciation','fixed_asset_depreciation_preview','run_fixed_asset_depreciation','fixed_asset_proposal_access','fixed_asset_proposal_report','process_fixed_asset_proposals','fixed_asset_ppe_account','capture_fixed_asset_journal_line','fixed_asset_proposal_origins','protect_capitalized_asset','protect_capitalized_category','protect_depreciated_asset_values']);
 for(const file of(await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;
  const sql=await readFile(new URL(file,dir),'utf8');
  for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(names.has(m[1]))await db.exec(m[0]);
 }
 // The prior manual-journal migration routes these trusted callers to its private writer.
 for(const signature of ['process_fixed_asset_proposals(jsonb)','run_fixed_asset_depreciation(date,jsonb)']){
  const def=(await db.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;
  await db.exec(def.replace(/(?<![\w.])(?:public\.)?create_journal_entry\(/g,'journal_entry_private.create_journal_entry('));
 }
}
