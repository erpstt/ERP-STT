import {readFile,readdir} from 'node:fs/promises';
import {setupPaymentRequestSecurity} from './setup-payment-request-security.mjs';
export async function setupPaymentBatchSecurity(db){
 await setupPaymentRequestSecurity(db);
 await db.exec(`create table auth.sessions(id text,user_id uuid,not_after timestamptz);insert into auth.sessions select 'fixture',auth_user_id,null from users;drop table payment_batch_items;drop table payment_batches;
 alter table suppliers add column supplier_type text;alter table countries add primary key(country_id);alter table bank_account add column country_id bigint default 1;
 alter table solicitudes_pago alter column batch_processing_status set default 'UNASSIGNED';
 create function public.digest(bytea,text) returns bytea language plpgsql immutable as $$begin if $2<>'sha256' then raise exception 'Unsupported test digest';end if;return sha256($1);end$$;`);
 const dir=new URL('../../supabase/migrations/',import.meta.url),sql=await readFile(new URL('20261003120000_supplier_payment_batches.sql',dir),'utf8');
 await db.exec(sql.slice(sql.indexOf('alter table public.suppliers'),sql.indexOf('-- Las secuencias')));
 const names=new Set(['payment_batch_has_permission','payment_batch_can','payment_batch_touch','payment_request_batch_guard','supplier_invoice_batch_guard','payment_request_transfer_amount','cr_iban_normalize','cr_iban_valid','cr_tax_id_valid','payment_batch_options','payment_batch_candidates','payment_batch_prepare','payment_batch_detail','payment_batch_finalize','payment_batch_file','payment_batch_report','payment_batch_mark_sent','payment_batch_cancel','payment_batch_apply_response','payment_batch_apply_reference']);
 for(const file of (await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;
  const text=await readFile(new URL(file,dir),'utf8');for(const m of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(names.has(m[1]))await db.exec(m[0]);
 }
 await db.exec(`create trigger batch_request_guard before update or delete on solicitudes_pago for each row execute function payment_request_batch_guard();
 create trigger batch_touch before update on payment_batches for each row execute function payment_batch_touch();
 insert into permissions(code) values('TREASURY_PAYMENT_BATCH_VIEW'),('TREASURY_PAYMENT_BATCH_MANAGE'),('TREASURY_PAYMENT_BATCH_EXECUTE');
 insert into role_permissions select r,p.permission_id from unnest(array[1,2,3,4]) r cross join permissions p where p.code like 'TREASURY_PAYMENT_BATCH_%';
 insert into user_roles values(1,4);insert into role_access_matrix values(1,'treasury:payment-batches',true,true,false,false),(2,'treasury:payment-batches',true,false,false,false),(3,'treasury:payment-batches',true,false,false,false),(4,'treasury:payment-batches',false,true,false,false);
 update bank_account set account_number='1234567890',iban=null where bank_account_id=1;
 insert into bank_payment_formats(country_id,format_code,format_name,file_extension,structure_definition,response_definition) values(1,'BAC_SYNTHETIC','Synthetic bank format','.txt','{"strategy":"BAC"}','{}');`);
 const base='010100000000000001',iban='CR'+String(98n-BigInt(base+'122700')%97n).padStart(2,'0')+base;
 await db.query("update suppliers set payment_iban=$1,payment_id_type='J',tax_id='3101000001' where supplier_id=10",[iban]);
 await db.exec('begin');await db.exec(await readFile(new URL('20261031183944_secure_payment_batches.sql',dir),'utf8'));await db.exec('commit');
}
