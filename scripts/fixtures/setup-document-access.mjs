import {readFile} from 'node:fs/promises';
export async function setupDocumentAccess(db){
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.user',true),'')::bigint$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function active_subsidiary_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.sid',true),'')::bigint$$;
 create function active_subsidiary_id_without_report_context()returns bigint language sql stable as $$select active_subsidiary_id()$$;
 create function app_is_admin()returns boolean language sql stable as $$select app_user_id()=2$$;
 create table users(user_id bigint primary key,is_active boolean);insert into users values(1,true),(2,true),(3,false);
 create table roles(role_id bigint primary key);insert into roles select x from generate_series(10,21)x;insert into roles values(99);
 create table subsidiaries(subsidiary_id bigint primary key);insert into subsidiaries values(1),(2);
 create table user_roles(user_id bigint,role_id bigint);insert into user_roles select 1,x from generate_series(10,21)x;insert into user_roles values(2,99),(3,10);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(1,2),(2,1),(3,1);
 create table grants(role_id bigint,resource text,v boolean,c boolean,e boolean,d boolean);
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer set search_path=public as $$begin if app_is_admin()then return;end if;if not exists(select 1 from grants where role_id=app_active_role_id()and resource=r and case a when'view'then v when'create'then c when'edit'then e when'delete'then d else false end)then raise exception using errcode='42501';end if;end$$;
 create schema report_template_private;revoke all on schema report_template_private from public;
 create table journal(journal_id bigint primary key,subsidiary_id bigint);insert into journal values(101,1),(202,2),(303,1),(404,1);
 `);
 const previous=await readFile('supabase/migrations/20261103032056_secure_financial_reports_pdf_templates.sql','utf8');await db.exec(previous.match(/create function report_template_private.enter[\s\S]*?end\$\$;/)[0]);
 await db.exec(await readFile('supabase/migrations/20260807070000_create_document_catalogs.sql','utf8'));
 // Match the current company policy names expected by the hardening migration.
 for(const table of ['folders','documents'])for(const op of ['select','insert','update','delete'])await db.exec(`alter policy documents_${op} on ${table} rename to company_${op}`);
 await db.exec(await readFile('supabase/migrations/20260828080000_journal_supports.sql','utf8'));
 await db.exec(`insert into folders(folder_name,subsidiary_id)values('Synthetic own',1),('Synthetic foreign',2);insert into folders(folder_name,subsidiary_id,parent_id)values('Synthetic child',1,1);
 insert into document_type(type_name,allowed_extensions,max_file_size_mb)values('Synthetic PDF','pdf',5);
 insert into documents(file_name,file_path,folder_id,type_id,uploaded_by_user_id,file_size,mime_type)values('Synthetic one','synthetic/one',1,1,1,4,'application/pdf'),('Synthetic two','synthetic/two',2,1,1,4,'application/pdf');
 insert into document_version(document_id,version_number,file_path)values(1,1,'synthetic/v1'),(2,1,'synthetic/v2');
 insert into document_relation(document_id,target_entity_type,target_entity_id)values(1,'SYNTHETIC',1),(2,'SYNTHETIC',2);
 insert into document_permission(document_id,role_id)values(1,10),(2,10);
 insert into journal_support(journal_id,support_type,display_name,support_url)values(101,'Enlace','Synthetic own','https://example.invalid/one'),(202,'Enlace','Synthetic foreign','https://example.invalid/two'),(303,'Enlace','Synthetic sale','https://example.invalid/sale'),(404,'Enlace','Synthetic payment','https://example.invalid/payment');
 grant all on folders,documents,document_type,document_version,document_relation,document_permission,journal_support to anon;
 grant select,insert,update,delete on folders,documents,document_type,document_version,document_relation,document_permission,journal_support to authenticated;grant usage,select on all sequences in schema public to authenticated;
 `);
 const resources=['folders','documents','document-types','document-versions','document-relations','document-permissions'].map(x=>'documents:'+x);
 for(const r of resources)for(const [role,v,c,e,d]of [[10,true,false,false,false],[11,true,true,true,true],[19,true,false,false,true],[20,true,true,false,false],[21,true,false,true,false]])await db.query('insert into grants values($1,$2,$3,$4,$5,$6)',[role,r,v,c,e,d]);
 await db.exec(`insert into grants values(12,'documents:folders',true,true,true,true),(13,'documents:document-versions',true,true,true,true),(14,'accounting:journal-supports',true,false,false,false),(15,'accounting:journal-supports',true,true,true,true),(16,'inventory:products',true,true,true,true),(17,'documents:documents',false,true,true,true),(18,'documents:document-types',true,true,true,true);`);
 // These restrictive bodies are replaced with captured production definitions by the test.
}
