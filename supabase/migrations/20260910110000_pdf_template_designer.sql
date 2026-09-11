create table if not exists pdf_templates(
 id bigint generated always as identity primary key,
 subsidiary_id bigint not null references subsidiaries on delete cascade,
 branch_id bigint references locations on delete set null,
 document_type text not null check(document_type in('FAC_VEN','NC_VEN','ND_VEN','ORD_COM','PED_VEN','COT_VEN','SOL_PAG','REC_PAG','ASI_DIA')),
 template_name text not null,
 page_size text not null default'A4'check(page_size in('A4','LETTER','THERMAL_80')),
 orientation text not null default'PORTRAIT'check(orientation in('PORTRAIT','LANDSCAPE')),
 visual_schema jsonb not null default'{}',html_compiled text not null default'',is_default boolean not null default false,is_system boolean not null default false,
 created_by bigint references users,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(subsidiary_id,branch_id,document_type,template_name)
);
create unique index if not exists pdf_template_default_scope on pdf_templates(subsidiary_id,coalesce(branch_id,0),document_type)where is_default;
alter table pdf_templates enable row level security;

create or replace function pdf_template_options()returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name),'branches',coalesce((select jsonb_agg(jsonb_build_object('id',l.location_id,'name',l.name)order by l.name)from locations l left join location_subsidiaries ls using(location_id)where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id),'[]'),'templates',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.template_name,'documentType',p.document_type,'pageSize',p.page_size,'orientation',p.orientation,'branchId',p.branch_id,'schema',p.visual_schema,'isDefault',p.is_default,'isSystem',p.is_system,'updatedAt',p.updated_at)order by p.document_type,p.is_default desc,p.template_name)from pdf_templates p where p.subsidiary_id=s.subsidiary_id),'[]'))from subsidiaries s where s.subsidiary_id=active_subsidiary_id()
$$;

create or replace function pdf_template_save(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();uid bigint:=app_user_id();pid bigint:=nullif(p->>'id','')::bigint;dtype text:=p->>'documentType';bid bigint:=nullif(p->>'branchId','')::bigint;
begin
 if dtype not in('FAC_VEN','NC_VEN','ND_VEN','ORD_COM','PED_VEN','COT_VEN','SOL_PAG','REC_PAG','ASI_DIA')then raise exception'Tipo de documento no soportado.';end if;
 if coalesce(trim(p->>'name'),'')=''then raise exception'Indique el nombre de la plantilla.';end if;
 if jsonb_typeof(p->'schema')<>'object'then raise exception'El diseño visual no es válido.';end if;
 if coalesce((p->>'isDefault')::boolean,false)then update pdf_templates set is_default=false,updated_at=now()where subsidiary_id=sid and document_type=dtype and coalesce(branch_id,0)=coalesce(bid,0);end if;
 if pid is null then insert into pdf_templates(subsidiary_id,branch_id,document_type,template_name,page_size,orientation,visual_schema,html_compiled,is_default,created_by)values(sid,bid,dtype,trim(p->>'name'),coalesce(p->>'pageSize','A4'),coalesce(p->>'orientation','PORTRAIT'),p->'schema',p->>'compiled',coalesce((p->>'isDefault')::boolean,false),uid)returning id into pid;
 else update pdf_templates set branch_id=bid,document_type=dtype,template_name=trim(p->>'name'),page_size=coalesce(p->>'pageSize','A4'),orientation=coalesce(p->>'orientation','PORTRAIT'),visual_schema=p->'schema',html_compiled=p->>'compiled',is_default=coalesce((p->>'isDefault')::boolean,false),updated_at=now()where id=pid and subsidiary_id=sid;if not found then raise exception'Plantilla no encontrada.';end if;end if;
 return jsonb_build_object('id',pid);
end$$;

create or replace function pdf_template_clone(p_id bigint)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$declare n bigint;begin insert into pdf_templates(subsidiary_id,branch_id,document_type,template_name,page_size,orientation,visual_schema,html_compiled,created_by)select subsidiary_id,branch_id,document_type,template_name||' - Copia',page_size,orientation,visual_schema,html_compiled,app_user_id()from pdf_templates where id=p_id and subsidiary_id=active_subsidiary_id()returning id into n;if n is null then raise exception'Plantilla no encontrada.';end if;return jsonb_build_object('id',n);end$$;
create or replace function pdf_template_delete(p_id bigint)returns void language plpgsql security definer set search_path=public,pg_temp as $$begin delete from pdf_templates where id=p_id and subsidiary_id=active_subsidiary_id()and not is_system;if not found then raise exception'La plantilla no existe o es una plantilla del sistema.';end if;end$$;
create or replace function pdf_template_compiled(p_id bigint)returns jsonb language sql stable security definer set search_path=public as $$select jsonb_build_object('id',id,'documentType',document_type,'pageSize',page_size,'orientation',orientation,'schema',visual_schema,'compiled',html_compiled)from pdf_templates where id=p_id and subsidiary_id=active_subsidiary_id()$$;

do $$declare s record;t text;schema jsonb:='{"version":1,"margins":{"top":12,"right":12,"bottom":12,"left":12},"zones":{"header":[{"id":"company","type":"text","content":"{{company.name}}","style":{"fontSize":22,"fontWeight":700,"color":"#123047"}},{"id":"title","type":"text","content":"{{document.title}} · {{document.number}}","style":{"fontSize":16,"fontWeight":700,"align":"right"}}],"body":[{"id":"entity","type":"text","content":"Cliente / Proveedor: {{entity.name}}","style":{"fontSize":11}},{"id":"items","type":"items_table","columns":["code","description","quantity","unit_price","tax_rate","subtotal"]},{"id":"totals","type":"totals"}],"footer":[{"id":"fiscal","type":"fiscal","content":"Clave: {{fiscal.electronic_key}} · Documento generado por NEXO ERP","locked":true}]}}'::jsonb;
begin for s in select subsidiary_id from subsidiaries loop foreach t in array array['FAC_VEN','NC_VEN','ND_VEN','ORD_COM','PED_VEN','COT_VEN','SOL_PAG','REC_PAG','ASI_DIA']loop insert into pdf_templates(subsidiary_id,document_type,template_name,visual_schema,is_default,is_system,created_by)values(s.subsidiary_id,t,'Plantilla estándar '||t,schema,true,true,app_user_id())on conflict do nothing;end loop;end loop;end$$;
grant execute on function pdf_template_options(),pdf_template_save(jsonb),pdf_template_clone(bigint),pdf_template_delete(bigint),pdf_template_compiled(bigint)to authenticated;
revoke all on table pdf_templates from anon;
notify pgrst,'reload schema';
