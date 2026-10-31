import{readFile,readdir}from'node:fs/promises';import{setupAssetMasterSecurity}from'./setup-asset-master-security.mjs';
export async function setupAssetOperationSecurity(db){
 await setupAssetMasterSecurity(db);
 await db.exec(`alter table suppliers add column primary_subsidiary_id bigint;
 insert into locations(location_id,name,subsidiary_id) values(2,'Synthetic target',2),(3,'Unassigned target',4);
 insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,gl_closed,is_inactive) values(20,2,'2026-10-01','2026-10-31',false,false,false);
 alter table asset_transfer alter column transfer_id add generated always as identity;alter table asset_disposal alter column disposal_id add generated always as identity;alter table asset_maintenance alter column maintenance_id add generated always as identity;
 alter table asset_transfer add foreign key(asset_id) references asset;alter table asset_disposal add foreign key(asset_id) references asset;alter table asset_maintenance add foreign key(asset_id) references asset;
 insert into roles values(6,'Creator',false),(7,'Editor',false),(8,'Deleter',false);insert into user_roles values(1,6),(1,7),(1,8);
 grant all on asset_transfer,asset_disposal,asset_maintenance to anon,authenticated,service_role;`);
 const names=new Set(['asset_operation_number','fixed_asset_operation_options','fixed_asset_operation_report','save_fixed_asset_operation','delete_fixed_asset_operation']),dir=new URL('../../supabase/migrations/',import.meta.url);
 for(const file of(await readdir(dir)).sort()){if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;const sql=await readFile(new URL(file,dir),'utf8');for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(names.has(m[1]))await db.exec(m[0]);}
 for(const resource of['fixed-assets:asset-transfers','fixed-assets:asset-disposals','fixed-assets:asset-maintenances'])await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(2,$1,true,true,true,true),(3,$1,true,false,false,false),(6,$1,false,true,false,false),(7,$1,false,false,true,false),(8,$1,false,false,false,true)',[resource]);
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/20261031144205_secure_asset_operations.sql',import.meta.url),'utf8'));await db.exec('commit');
}
