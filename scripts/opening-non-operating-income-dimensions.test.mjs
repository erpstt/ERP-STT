import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const migration=await readFile(new URL('../supabase/migrations/20261113181212_opening_non_operating_income_optional_cost_center.sql',import.meta.url),'utf8');
test('non-operating income permits department without cost center; other dimension rules and access remain intact',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;
 create table account_group(group_id bigint primary key,parent_id bigint,group_name text);
 create table chart_accounts(account_id bigint primary key,account_group_id bigint,account_number text,category text);
 insert into account_group values(1,null,'Ingresos'),(2,1,'Otros Ingresos No Operativos'),(3,2,'Subgrupo de prueba'),(4,1,'Ingresos Financieros'),(5,1,'Ingresos Operativos'),(6,1,'Ganancia Cambiaria'),(7,null,'Costos'),(8,null,'Gastos');
 insert into chart_accounts values(1,2,'423001','Ingreso'),(2,2,'423002','Ingreso'),(3,2,'423003','Ingreso'),(4,3,'999001','Ingreso'),(5,4,'421001','Ingreso'),(6,5,'413001','Ingreso'),(7,6,'422001','Ingreso'),(8,7,'511001','Costo'),(9,8,'611001','Gasto'),(10,5,'423999','Ingreso');
 create function account_belongs_to_group(p_account_id bigint,p_group_pattern text)returns boolean language sql stable security definer set search_path=public as $$
 with recursive ancestry as(select g.group_id,g.parent_id,g.group_name from chart_accounts a join account_group g on g.group_id=a.account_group_id where a.account_id=p_account_id union all select parent.group_id,parent.parent_id,parent.group_name from account_group parent join ancestry child on child.parent_id=parent.group_id)
 select exists(select 1 from ancestry where group_name~*p_group_pattern)$$;
 create function opening_balance_is_financial_income(bigint)returns boolean language sql stable as $$select public.account_belongs_to_group($1,'(^|[^[:alnum:]])ingresos?[[:space:]]+financieros?([^[:alnum:]]|$)')$$;`);
 const before=(await db.query('select jsonb_agg(to_jsonb(a)order by account_id)d from chart_accounts a')).rows[0].d;
 await db.exec(migration);await db.exec(migration);
 const validate=(id,category='Ingreso',department=101,center=null)=>db.query('select public.opening_balance_assert_result_dimensions($1,$2,$3,$4,5)',[id,category,department,center]);
 for(const id of [1,2,3,4]){assert.equal((await db.query('select public.opening_balance_is_non_operating_income($1)d',[id])).rows[0].d,true);await validate(id);}
 await validate(5,'Ingreso',null); // Existing financial-income exception.
 for(const id of [6,7,10]){await assert.rejects(validate(id),/centro de costos es obligatorio/);await validate(id,'Ingreso',101,202);}
 await assert.rejects(validate(8,'Costo'),/centro de costos es obligatorio/);await validate(8,'Costo',null,202);
 await assert.rejects(validate(9,'Gasto',null),/departamento es obligatorio/);await validate(9,'Gasto',101);
 assert.equal((await db.query('select public.opening_balance_is_non_operating_income(10)d')).rows[0].d,false); // Prefix does not override group.
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(a)order by account_id)d from chart_accounts a')).rows[0].d,before);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(validate(1),/permission denied/);await assert.rejects(db.query('select public.opening_balance_is_non_operating_income(1)'),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});
