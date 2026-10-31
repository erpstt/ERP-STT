import{readFile}from'node:fs/promises';
import{loadLegacyJournalFunctions}from'./load-legacy-journal-functions.mjs';
import{loadLegacyAssetPostingFunctions}from'./load-legacy-asset-posting-functions.mjs';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
export async function setupAssetMasterSecurity(db){
 for(const f of ['consolidation-security.sql','bank-transfer-security.sql','manual-journal-security.sql'])await db.exec(await read('./'+f));
 const dims=await read('../journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await loadLegacyJournalFunctions(db);await db.exec('begin');await db.exec(await read('../../supabase/migrations/20261031022533_secure_manual_journals.sql'));await db.exec('commit');
 await db.exec('drop function process_fixed_asset_proposals(jsonb);drop function run_fixed_asset_depreciation(date,jsonb)');
 await db.exec(await read('./asset-posting-security.sql'));
 for(const [table,key]of [['suppliers','supplier_id'],['departments','department_id'],['cost_centers','cost_center_id'],['classes','class_id']])await db.exec(`alter table ${table} add primary key(${key})`);
 const original=await read('../../supabase/migrations/20260917140000_fixed_asset_capitalization_proposals.sql');
 await db.exec(original.slice(original.indexOf('create table activos_fijos_propuestas'),original.indexOf('create table fixed_asset_proposal_allocation')));
 await db.exec(await read('./asset-master-security.sql'));await loadLegacyAssetPostingFunctions(db,['asset_category_options','asset_category_report','save_asset_category','delete_asset_category','fixed_asset_report','fixed_asset_detail','fixed_asset_analytics','assign_asset_category_code','validate_asset_category_account_groups','protect_used_asset_category_accounting','protect_opening_fixed_asset_values','account_belongs_to_group']);
 await db.exec(`create trigger asset_number before insert on asset for each row execute function assign_fixed_asset_number();create trigger capitalized_asset before update or delete on asset for each row execute function protect_capitalized_asset();create trigger depreciated_values before update on asset for each row execute function protect_depreciated_asset_values();
 insert into permissions(code) values('fixed-assets:proposals:manage');insert into role_permissions select 1,permission_id from permissions where code='fixed-assets:proposals:manage';
 insert into "transaction"(tran_number,subsidiary_id,currency_id) values('SOURCE1',1,1),('SOURCE2',1,1),('SOURCE3',2,2);
 insert into gl_impact(subsidiary_id,transaction_id,account_id,posting_date,debit_amount,credit_amount,debit_fx,credit_fx,accounting_book_id) values(1,1,201,'2026-10-01',1200,0,1200,0,1),(1,2,201,'2026-10-02',600,0,600,0,1),(2,3,201,'2026-10-01',1200,0,1200,0,1);
 insert into activos_fijos_propuestas(subsidiary_id,gl_impact_id,transaction_id,account_id,currency_id,source_number,source_date,amount_local,amount_foreign) select subsidiary_id,gl_impact_id,transaction_id,account_id,case when subsidiary_id=1 then 1 else 2 end,'SOURCE','2026-10-01',debit_amount,debit_fx from gl_impact where transaction_id in(1,3);
 insert into activos_fijos_propuestas(subsidiary_id,gl_impact_id,transaction_id,account_id,currency_id,source_number,source_date,amount_local,amount_foreign) select subsidiary_id,gl_impact_id,transaction_id,account_id,1,'SOURCE','2026-10-02',debit_amount,debit_fx from gl_impact where transaction_id=2;`);
 for(const resource of ['fixed-assets:asset-proposals','fixed-assets:asset-depreciations','fixed-assets:assets'])await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(2,$1,true,true,true,true),(3,$1,true,false,false,false)',[resource]);
 await db.exec('begin');await db.exec(await read('../../supabase/migrations/20261031132735_secure_asset_proposals_depreciation.sql'));await db.exec('commit');
 await db.exec('create trigger category_code before insert or update of category_code on asset_category for each row execute function assign_asset_category_code();create trigger category_used before update on asset_category for each row execute function protect_used_asset_category_accounting();create trigger category_groups before insert or update on asset_category for each row execute function validate_asset_category_account_groups();create trigger opening_asset before insert or update or delete on asset for each row execute function protect_opening_fixed_asset_values();create trigger local_asset before insert or update on asset for each row execute function validate_fixed_asset_local_currency()');
 await db.exec('begin');await db.exec(await read('../../supabase/migrations/20261031141516_secure_asset_master_categories.sql'));await db.exec('commit');
}
