import {readFile} from 'node:fs/promises';import {setupPurchaseOrderSecurity} from './setup-purchase-order-security.mjs';
export async function setupPurchaseReceiptSecurity(db){
 await setupPurchaseOrderSecurity(db);
 await db.exec(`create table goods_receipt(receipt_id bigint primary key,po_id bigint,transaction_id bigint,location_id bigint);
 insert into role_access_matrix values(1,'purchasing:goods-receipts',true,true,true,true),(2,'purchasing:goods-receipts',true,false,false,false),(3,'purchasing:goods-receipts',true,false,false,false);
 create unique index if not exists supplier_invoice_one_per_purchase_receipt_idx on supplier_invoice(purchase_receipt_document_id) where purchase_receipt_document_id is not null;`);
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/20261031192746_secure_purchase_receipts.sql',import.meta.url),'utf8'));await db.exec('commit');
}
