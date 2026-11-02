import {readFile} from 'node:fs/promises';
export const rateCatalogReadMigration='20261102201439_optimize_exchange_rate_catalog_reads.sql';
export async function installRateCatalogReadOptimization(db){
 await db.exec(await readFile(new URL('../../supabase/migrations/'+rateCatalogReadMigration,import.meta.url),'utf8'));
}
