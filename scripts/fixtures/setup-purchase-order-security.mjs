import {readFile,readdir} from 'node:fs/promises';import {setupPaymentRequestSecurity} from './setup-payment-request-security.mjs';
export async function setupPurchaseOrderSecurity(db){
 await setupPaymentRequestSecurity(db);
 await db.exec(`alter table suppliers add column payment_term_id bigint;create table sales_document(document_id bigint,document_type text,status text,source_document_id bigint);create table products(product_id bigint primary key,item_code text,display_name text,purchase_cost numeric,purchase_account_id bigint,tax_code_id bigint,is_active boolean,product_usage text);
 create table product_subsidiaries(product_id bigint,subsidiary_id bigint,is_active boolean);
 create table stock_movements(movement_id bigint generated always as identity,transaction_id bigint,movement_date date,product_id bigint,location_id bigint,quantity numeric,movement_type text,unit_cost numeric);
 create table purchase_order(po_id bigint primary key,po_number text,transaction_id bigint,supplier_id bigint,subsidiary_id bigint,currency_id bigint,status_id bigint);
 insert into products values(1,'SYN','Synthetic item',50,203,1,true,'Compra');insert into product_subsidiaries values(1,1,true);
 insert into transaction_types(transaction_type_id,abbreviation,name) values(31,'ORD_COM','Synthetic order'),(32,'REQ_COM','Synthetic requisition'),(33,'COT_PRO','Synthetic quote'),(34,'REC_INV','Synthetic receipt');
 alter table tax_codes add column if not exists subsidiary_id bigint default 1;
 drop function if exists save_purchase_document_without_budget(jsonb,bigint);drop function if exists save_purchase_document(jsonb,bigint);`);
 const dir=new URL('../../supabase/migrations/',import.meta.url),original=await readFile(new URL('20260903210000_purchase_workflow.sql',dir),'utf8');
 await db.exec(original.match(/create table if not exists purchase_document_line\([\s\S]*?;/i)[0]);
 const names=new Set(['purchase_workflow_options','purchase_document_report','purchase_document_detail','save_purchase_document','save_purchase_document_without_budget','delete_purchase_document','validate_purchase_document_header_scope','validate_purchase_document_line_scope','validate_purchase_receipt_quantity','wf_protect_purchase_order','wf_require_approved_source']);
 for(const file of(await readdir(dir)).sort()){
  if(!file.endsWith('.sql')||file>'20261030235959.sql')continue;const sql=await readFile(new URL(file,dir),'utf8'),events=[];
  for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\$\$[\s\S]*?\$\$\s*;/gi))if(names.has(m[1]))events.push({index:m.index,sql:m[0]});
  for(const m of sql.matchAll(/alter\s+function\s+(?:public\.)?([a-z0-9_]+)\s*(\([^;]+?\))\s*rename\s+to\s+([a-z0-9_]+)\s*;/gi))if(names.has(m[1])&&names.has(m[3]))events.push({index:m.index,sql:m[0]});
  for(const e of events.sort((a,b)=>a.index-b.index))await db.exec(e.sql);
 }
 await db.exec(`create trigger purchase_header_scope before insert or update on purchase_document for each row execute function validate_purchase_document_header_scope();
 create trigger purchase_line_scope before insert or update on purchase_document_line for each row execute function validate_purchase_document_line_scope();
 create trigger receipt_quantity before insert or update on purchase_document_line for each row execute function validate_purchase_receipt_quantity();
 create trigger wf_protect_purchase_order_trigger before update on purchase_document for each row execute function wf_protect_purchase_order();
 create trigger wf_purchase_approved_source before insert or update of source_document_id,document_type on purchase_document for each row execute function wf_require_approved_source();
 insert into role_access_matrix values(1,'purchasing:orders',true,true,true,true),(2,'purchasing:orders',true,false,true,false),(3,'purchasing:orders',true,false,false,false),(4,'purchasing:orders',true,false,false,false);
 insert into wf_workflows(nombre,entity_type,subsidiaria_id) values('Synthetic order approval','PURCHASE_ORDER',1);
 insert into wf_rules(workflow_id,nivel,nombre_nivel,usuario_aprobador_id,politica) select id,1,'Synthetic reviewer',2,'CUALQUIERA' from wf_workflows where entity_type='PURCHASE_ORDER';`);
 await db.exec('begin');await db.exec(await readFile(new URL('20261031190207_secure_purchase_orders.sql',dir),'utf8'));await db.exec('commit');
}
