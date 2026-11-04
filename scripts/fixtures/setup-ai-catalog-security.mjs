import {readFile} from 'node:fs/promises';

export const aiResources=['ai:ai-agents','ai:ai-prompts','ai:ai-conversations','ai:ai-documents','ai:ai-predictions'];

// All identities, grants and records are synthetic. The context guard and AI
// table definitions come from the real migrations; no remote services run here.
export async function setupAiCatalogSecurity(db){
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.user',true),'')::bigint$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function active_subsidiary_id_without_report_context()returns bigint language sql stable as $$select nullif(current_setting('fixture.sid',true),'')::bigint$$;
 create function active_subsidiary_id()returns bigint language sql stable as $$select coalesce(nullif(current_setting('fixture.report_sid',true),'')::bigint,active_subsidiary_id_without_report_context())$$;
 create function app_is_admin()returns boolean language sql stable as $$select app_user_id()=2$$;
 create table users(user_id bigint primary key,is_active boolean not null);insert into users values(1,true),(2,true),(3,false),(4,true);
 create table user_roles(user_id bigint,role_id bigint);insert into user_roles values(1,10),(1,11),(1,12),(1,13),(2,99),(3,10),(4,10);
 create table subsidiaries(subsidiary_id bigint primary key);insert into subsidiaries values(1),(2);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(1,2),(2,1),(3,1),(4,2);
 create table grants(role_id bigint,resource text,v boolean,c boolean,e boolean,d boolean);
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$begin if app_is_admin()then return;end if;if not exists(select 1 from grants where role_id=app_active_role_id()and resource=r and case a when'view'then v when'create'then c when'edit'then e when'delete'then d else false end)then raise exception using errcode='42501';end if;end$$;
 create schema report_template_private;revoke all on schema report_template_private from public;
 create table folders(folder_id bigint primary key,subsidiary_id bigint not null references subsidiaries);
 create table documents(document_id bigint primary key,folder_id bigint not null references folders);
 insert into folders values(1,1),(2,2);insert into documents values(1,1),(2,2);
 alter table folders enable row level security;alter table documents enable row level security;
 grant select on folders,documents to authenticated;`);
 for(const resource of aiResources)await db.query('insert into grants values(10,$1,true,true,true,true),(11,$1,true,false,false,false),(12,$1,false,true,true,true),(13,$1,false,false,false,false)',[resource]);
 const report=await readFile('supabase/migrations/20261103032056_secure_financial_reports_pdf_templates.sql','utf8');
 const enter=report.match(/create function report_template_private.enter[\s\S]*?end\$\$;/);
 if(!enter)throw Error('Missing real report context guard');await db.exec(enter[0]);
 await db.exec(await readFile('supabase/migrations/20260807100000_create_ai_catalogs.sql','utf8'));
 for(const op of ['select','insert','update','delete'])await db.exec(`alter policy ai_${op} on ai_prediction rename to company_${op}`);
 await db.exec(`insert into ai_agents(agent_name,system_prompt,model_version)values('SYN-ONE','Synthetic configuration','synthetic-v1'),('SYN-TWO','Synthetic second','synthetic-v1'),('SYN-EMPTY','Synthetic unused','synthetic-v1');
 insert into ai_prompt(agent_id,prompt_name,prompt_text,module_target)values(1,'SYN-PROMPT','Synthetic input','Synthetic');
 insert into ai_conversation(user_id,agent_id,started_at)values(1,2,'2026-11-03T00:00:00Z'),(4,2,'2026-11-03T00:00:00Z'),(2,2,'2026-11-03T00:00:00Z');
 insert into ai_document(document_id,extracted_data_json,confidence_score)values(1,'{"synthetic":1}',90),(2,'{"synthetic":2}',80);
 insert into ai_prediction(subsidiary_id,prediction_type,target_entity_id,value_predicted,confidence,execution_date)values(1,'SYN',1,10,90,'2026-11-03'),(2,'SYN',2,20,80,'2026-11-03');
 grant select,insert,update,delete on ai_agents,ai_prompt,ai_conversation,ai_document,ai_prediction to anon,authenticated,service_role;
 grant usage,select,update on all sequences in schema public to anon,authenticated,service_role;`);
}
