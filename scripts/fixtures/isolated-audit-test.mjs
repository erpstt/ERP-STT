import {PGlite} from '@electric-sql/pglite';
import {setupAuditRawSecurity} from './setup-audit-raw-security.mjs';

// In-memory only: no connection string, environment file or external database.
export async function isolatedAuditDatabase(){
 const db=new PGlite();
 try{await setupAuditRawSecurity(db);return db;}
 catch(error){await db.close();throw error;}
}
