import {readFile} from 'node:fs/promises';
export async function setupStatementLedger(db){
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function auth.role()returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','authenticated')$$;
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.user',true),'')::bigint$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function active_subsidiary_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.sid',true),'')::bigint$$;
 create function active_subsidiary_id_without_report_context()returns bigint language sql stable as $$select active_subsidiary_id()$$;
 create function app_is_admin()returns boolean language sql stable as $$select app_user_id()=2$$;
 create table users(user_id bigint primary key,is_active boolean,email text);insert into users values(1,true,'synthetic@example.invalid'),(2,true,'admin@example.invalid'),(3,false,'inactive@example.invalid');
 create table user_roles(user_id bigint,role_id bigint);insert into user_roles values(1,10),(1,20),(1,30),(1,40),(1,50),(1,60),(1,70),(2,99),(3,10);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(1,2),(2,1),(3,1);
 create table role_access_matrix(role_id bigint,resource_key text,can_view boolean,can_create boolean,can_edit boolean,can_delete boolean);
 insert into role_access_matrix values(10,'reports:accounting-reports',true,false,false,false),(10,'entities:customers',true,false,false,false),(20,'entities:customers',true,false,true,false),(30,'accounting:journals',true,false,false,false),(40,'accounting:journal-lines',true,false,false,false),(50,'accounting:gl-impacts',true,false,false,false),(60,'inventory:products',true,false,false,false),(70,'reports:accounting-reports',true,false,false,false),(70,'entities:customers',true,false,true,false);
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer as $$begin if app_is_admin()then return;end if;if not exists(select 1 from role_access_matrix where role_id=app_active_role_id()and resource_key=r and case a when'view'then can_view when'edit'then can_edit when'create'then can_create else can_delete end)then raise exception using errcode='42501';end if;end$$;
 create table journal(journal_id bigint primary key,subsidiary_id bigint,memo text);create table journal_line(line_id bigint primary key,journal_id bigint,amount numeric);create table gl_impact(impact_id bigint primary key,subsidiary_id bigint,amount numeric);
 insert into journal values(1,1,'Synthetic one'),(2,2,'Synthetic two');insert into journal_line values(1,1,100),(2,2,200);insert into gl_impact values(1,1,100),(2,2,200);
 alter table journal enable row level security;alter table journal_line enable row level security;alter table gl_impact enable row level security;
 create policy company_select on journal for select to authenticated using(app_is_admin()or subsidiary_id=active_subsidiary_id());
 create policy company_select on journal_line for select to authenticated using(app_is_admin()or exists(select 1 from journal where journal_id=journal_line.journal_id and subsidiary_id=active_subsidiary_id()));
 create policy company_select on gl_impact for select to authenticated using(app_is_admin()or subsidiary_id=active_subsidiary_id());grant select on journal,journal_line,gl_impact to authenticated;
 create table currencies(currency_id bigint,currency_code text);insert into currencies values(1,'USD');create table subsidiaries(subsidiary_id bigint,name text,logo_url text,address text,currency_id bigint);insert into subsidiaries values(1,'Synthetic one','','',1),(2,'Synthetic two','','',1);
 create table customers(customer_id bigint,company_name text,customer_number text,email text);insert into customers values(1,'Synthetic customer','001','customer@example.invalid'),(2,'Other customer','002','other@example.invalid');
 create table entity_subsidiaries(customer_id bigint,subsidiary_id bigint);insert into entity_subsidiaries values(1,1),(2,2);
 create table configuraciones_correos(id bigint,id_subsidiaria bigint,tipo_notificacion text,asunto_template text,cuerpo_template text,activo boolean,updated_by_email text,envio_dia integer,envio_hora time,updated_at timestamptz,unique(id_subsidiaria,tipo_notificacion));
 create table comunicaciones_logs(id uuid,customer_id bigint,id_subsidiaria bigint,tipo_notificacion text,estado text,destinatario text,fecha_corte date,created_at timestamptz,enviado_at timestamptz,ultimo_error text);
 insert into comunicaciones_logs values('00000000-0000-0000-0000-000000000001',1,1,'ESTADO_CUENTA','PENDIENTE','customer@example.invalid','2026-10-31',now(),null,null);
 create table enqueue_calls(sid bigint,customer bigint,note text);create function statement_enqueue(p_sid bigint,p_customer bigint,p_cutoff date,p_key text,p_note text default'',p_auto boolean default false)returns uuid language plpgsql security definer as $$begin insert into enqueue_calls values(p_sid,p_customer,p_note);return '00000000-0000-0000-0000-000000000001'::uuid;end$$;
 create table permissions(permission_id bigint,code text);insert into permissions values(1,'REPORT_SCHEDULE_MANAGE');create table role_permissions(role_id bigint,permission_id bigint);insert into role_permissions values(10,1),(99,1);
 create function scheduled_report_validate_options(bigint,text,jsonb)returns void language plpgsql stable as $$begin return;end$$;
 create table scheduled_report_catalog(code text,name text);insert into scheduled_report_catalog values('AR','Synthetic AR'),('income-statement','Synthetic income');
 `);
 const old=await readFile('supabase/migrations/20261103032056_secure_financial_reports_pdf_templates.sql','utf8');const start=old.indexOf('create function report_template_private.enter'),end=old.indexOf('end$$;',start)+7;await db.exec('create schema report_template_private;'+old.slice(start,end));
 const calcs=JSON.parse(await readFile(new URL('./report-delivery-signatures.json',import.meta.url),'utf8'));
 for(const f of calcs){
  const name=f.signature.split('(')[0];let body="begin return jsonb_build_object('rows','[]'::jsonb,'total',0,'summary',jsonb_build_object('subledger',100,'advances',5,'netBalance',95),'scope',(p_filters->'subsidiaryIds'->>0)::bigint);end";
  if(name==='run_aging_report')body='begin return public.run_aging_report_before_consolidation(p_kind,p_filters);end';
  if(name==='run_aging_report_before_consolidation')body='begin return run_aging_report_before_original_currency_reconciliation(p_kind,p_filters);end';
  const directive=name==='run_sales_transaction_report'?'\n#variable_conflict use_variable\n':'';
  if(f.primary)body="begin perform report_template_private.enter('reports:accounting-reports','view');\n"+body+';\nend';
  await db.exec(`create function ${name}(${f.arguments})returns ${f.result} language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $calc$${directive+body}$calc$;revoke all on function ${f.signature} from public,anon,service_role;grant execute on function ${f.signature} to authenticated;`);
 }
 const entries=JSON.parse(await readFile(new URL('./statement-worker-baseline.json',import.meta.url),'utf8'));
 for(const f of entries){const name=f.signature.split('(')[0];await db.exec(`create function ${name}(${f.arguments})returns ${f.result} language ${f.language} ${f.stable?'stable':''} security definer set search_path=pg_catalog,public,pg_temp as $baseline$${f.source}$baseline$;revoke all on function ${f.signature} from public,anon,authenticated,service_role;`);
  const worker=name==='statement_snapshot'||name==='scheduled_report_snapshot'||name==='scheduled_report_snapshot_v2';await db.exec(`grant execute on function ${f.signature} to ${worker?'service_role':'authenticated'}`);
  if(name.startsWith('scheduled_report_snapshot'))await db.exec(`grant execute on function ${f.signature} to authenticated`);
 }
}
