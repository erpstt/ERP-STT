import{readFile}from'node:fs/promises';
import{setupPurchaseReceiptSecurity}from'./setup-purchase-receipt-security.mjs';
export const supplierInvoiceLocationMigration='20261105170818_preserve_supplier_invoice_selected_location.sql';
const read=p=>readFile(new URL(p,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
export async function setupSupplierInvoiceLocation(db){
 await setupPurchaseReceiptSecurity(db);
 // Bring only the two target definitions to their published production baseline.
 const entityMigration=await read('../../supabase/migrations/20261101150451_secure_entity_masters.sql');
 const supplierGuard=entityMigration.match(/do \$\$declare source text;begin\n source:=pg_get_functiondef\('supplier_invoice_private\.prepare_before_receipt[\s\S]*?end\$\$;/)?.[0];
 const centerMigration=await read('../../supabase/migrations/20261101160132_secure_classes_cost_centers.sql');
 const centerGuard=[...centerMigration.matchAll(/do \$patch\$[\s\S]*?end\$patch\$;/g)].map(m=>m[0]).find(s=>s.includes('supplier_invoice_private.save_supplier_invoice_without_withholding'));
 if(!supplierGuard||!centerGuard)throw new Error('Published supplier invoice compatibility guards not found');
 await db.exec(supplierGuard);await db.exec(centerGuard);
 await db.exec(`
 alter table cost_centers add column if not exists cost_center_type text;
 alter table cost_centers add column if not exists department_id bigint;
 alter table locations add column if not exists subsidiary_id bigint;
 update locations set name='A synthetic default',subsidiary_id=1 where location_id=1;
 insert into locations(location_id,name,subsidiary_id)values(2,'Z synthetic selected',1),(3,'Y synthetic owned',1),(4,'X synthetic shared',2),(9,'Foreign synthetic location',2);
 insert into location_subsidiaries(location_id,subsidiary_id)values(2,1),(4,1),(9,2);
 insert into subsidiary_currencies(subsidiary_id,currency_id)select 1,2 where not exists(select 1 from subsidiary_currencies where subsidiary_id=1 and currency_id=2);
 update bank_account set currency_id=2,balance=1000 where bank_account_id=2;
 do $$declare f regprocedure;begin foreach f in array array['supplier_invoice_private.prepare_before_receipt(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_withholding(jsonb,bigint)'::regprocedure,'supplier_invoice_private.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)'::regprocedure]loop execute replace(pg_get_functiondef(f),E'\\r\\n',E'\\n');end loop;end$$;
 `);
}
export async function applySupplierInvoiceLocationMigration(db){
 await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+supplierInvoiceLocationMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
