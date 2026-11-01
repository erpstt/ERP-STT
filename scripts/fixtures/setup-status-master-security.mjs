import{readFile}from'node:fs/promises';import{setupTransactionTypeSecurity}from'./setup-transaction-type-security.mjs';
export const migration='20261101234503_secure_status_catalog.sql',activation='20261101234514_activate_status_boundary_after_server.sql';
export async function setupStatusMasterSecurity(db){await setupTransactionTypeSecurity(db);await installStatusMasterSecurity(db);}
export async function installStatusMasterSecurity(db){await db.exec(`create table status(status_id bigint generated always as identity primary key,code varchar(30)not null,name text not null,module text not null,description text,unique(code,module));
 insert into status(code,name,module,description)values('APROBADO','Approved','Transacciones','Synthetic description'),('BORRADOR','Draft','Transacciones',null),('PERIODO_ABIERTO','Open period','Contabilidad',null);
 alter table "transaction"add column status_id bigint references status;
 create table synthetic_status_reference(id bigint primary key,status_id bigint references status on delete cascade);
 insert into "transaction"(tran_number,transaction_type_id,subsidiary_id,status_id)values('SYNTH-DOCUMENT',1,1,2);
 create function synthetic_reserved_status()returns text language sql as $$select 'RESERVED_STATUS'$$;
 insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'core:status',true,true,true,true),(3,'core:status',true,false,false,false);
 grant all on status to anon,authenticated,service_role;grant usage,select,update on sequence status_status_id_seq to anon,authenticated,service_role;`);
 for(const n of[migration,activation])await db.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
 await db.exec(`create function trusted_status_transition(doc bigint,target_code text)returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$declare sid bigint;begin
 perform sequence_security_private.actor();if target_code<>'APROBADO'or not exists(select 1 from role_access_matrix where role_id=public.app_active_role_id()and resource_key='accounting:journals'and can_view and can_create)then raise exception using errcode='42501',message='Synthetic operation permission required';end if;
 select t.subsidiary_id into sid from "transaction"t join status s using(status_id)where t.transaction_id=doc and s.code='BORRADOR';if sid is null or not sequence_security_private.member(sid)then raise exception using errcode='42501',message='Synthetic document scope denied';end if;
 update "transaction"set status_id=(select status_id from status where code=target_code)where transaction_id=doc;end$$;
 revoke all on function trusted_status_transition(bigint,text)from public,anon,authenticated,service_role;grant execute on function trusted_status_transition(bigint,text)to authenticated;`);
}
