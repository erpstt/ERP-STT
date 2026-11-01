import{readFile}from'node:fs/promises';import{setupSequenceSecurity}from'./setup-sequence-security.mjs';
export const migration='20261101220448_secure_transaction_type_catalog.sql',activation='20261101220852_activate_transaction_type_boundary_after_server.sql';
export async function setupTransactionTypeSecurity(db){await setupSequenceSecurity(db);await installTransactionTypeSecurity(db);}
export async function installTransactionTypeSecurity(db){await db.exec(`alter table transaction_types add column module_category text not null default 'Contabilidad',add column description text not null default 'Synthetic description';
 alter table "transaction"add constraint synthetic_transaction_type_fk foreign key(transaction_type_id)references transaction_types;
 create table series(series_id bigint generated always as identity primary key,transaction_type_id bigint references transaction_types);
 create table approval_matrix(matrix_id bigint generated always as identity primary key,transaction_type_id bigint references transaction_types);
 create function synthetic_reserved_type()returns text language sql as $$select 'RESERVED_TYPE'$$;`);
 for(const n of[migration,activation])await db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
}
