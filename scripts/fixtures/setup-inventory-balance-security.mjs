import {readFile} from 'node:fs/promises';import {setupPurchaseReceiptSecurity} from './setup-purchase-receipt-security.mjs';
export async function setupInventoryBalanceSecurity(db){
 await setupPurchaseReceiptSecurity(db);const read=n=>readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8');
 const names=new Set(['warehouse_locations','bins','stock','stock_lots','stock_serials','stock_transfer','stock_adjustment','stock_reservation']);
 for(const file of ['20260806190000_create_inventory_catalogs.sql','20260806230000_add_inventory_movement_tables.sql']){const sql=await read(file);for(const m of sql.matchAll(/create table if not exists public\.([a-z_]+)\([\s\S]*?;/g))if(names.has(m[1]))await db.exec(m[0]);}
 await db.exec(`insert into products values(2,'FOREIGN','Synthetic foreign item',50,203,1,true,'Compra');insert into product_subsidiaries values(2,2,true);
 insert into locations(location_id,name,subsidiary_id) values(2,'Foreign warehouse',2),(3,'Second own warehouse',1);
 insert into warehouse_locations(warehouse_location_id,location_id,zone_name) overriding system value values(1,1,'Own zone'),(2,2,'Foreign zone');
 insert into bins(bin_id,bin_code,warehouse_location_id) overriding system value values(1,'OWN-BIN',1),(2,'FOREIGN-BIN',2);
 insert into stock(stock_id,product_id,location_id,bin_id,quantity_on_hand,quantity_available) overriding system value values(1,1,1,1,10,10),(2,2,2,2,20,20),(3,1,1,2,30,30),(4,2,1,null,40,40);
 insert into stock_lots(lot_id,lot_number,product_id,location_id,quantity) overriding system value values(1,'OWN-LOT',1,1,10),(2,'FOREIGN-LOT',2,2,20);
 insert into stock_serials(serial_id,serial_number,product_id,location_id,lot_id,status) overriding system value values(1,'OWN-SERIAL',1,1,1,'DISPONIBLE'),(2,'FOREIGN-SERIAL',2,2,2,'DISPONIBLE'),(3,'MISMATCHED-LOT',1,1,2,'DISPONIBLE');
 insert into stock_reservation(reservation_id,product_id,location_id,transaction_id,quantity_reserved) overriding system value values(1,1,1,1,1),(2,2,2,3,1),(3,1,1,3,1);
 insert into stock_transfer(transfer_id,transfer_number,transaction_id,source_location_id,target_location_id,status_id) overriding system value values(1,'OWN-TRANSFER',1,1,3,1),(2,'FOREIGN-TRANSFER',3,2,1,1);
 insert into stock_adjustment(adjustment_id,adjustment_number,transaction_id,location_id,account_id,reason,total_cost) overriding system value values(1,'OWN-ADJUSTMENT',1,1,203,'Synthetic',10),(2,'FOREIGN-ADJUSTMENT',3,2,203,'Synthetic',20);
 `);
 for(const slug of ['stock','stock-adjustments','stock-lots','stock-serials','stock-reservations','stock-transfers','stock-movements'])await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['inventory:'+slug]);
 await db.exec('begin');await db.exec(await read('20261031194320_secure_inventory_balances.sql'));await db.exec('commit');
}
