import{readFile}from'node:fs/promises';
import{setupSupplierInvoiceLocation,applySupplierInvoiceLocationMigration}from'./setup-supplier-invoice-location.mjs';
export const supplierInvoicePerformanceMigration='20261105170823_defer_supplier_invoice_row_gl_sync.sql';
export async function setupSupplierInvoicePerformance(db){await setupSupplierInvoiceLocation(db);await applySupplierInvoiceLocationMigration(db);}
export async function applySupplierInvoicePerformanceMigration(db){
 const source=await readFile(new URL('../../supabase/migrations/'+supplierInvoicePerformanceMigration,import.meta.url),'utf8');
 await db.exec('begin');try{await db.exec(source.replace(/\r\n/g,'\n'));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
