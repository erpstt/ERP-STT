import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");

  const installed=await one(`select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='journal_line'
      and column_name='service_country_id'
  ) value`);
  if(!installed.value){
    await db.query(await readFile(new URL('../supabase/migrations/20261001090000_add_pending_journal_service_country.sql',import.meta.url),'utf8'));
  }
  const historicalMissing=await one(`select count(*)::int value
    from public.journal_line line
    join public.journal entry using(journal_id)
    where (entry.journal_type='Asientos Pendientes de Facturar' or entry.journal_number like 'ASI_PEN-%')
      and line.service_country_id is null`);
  assert.equal(historicalMissing.value,0,'Las líneas ASI_PEN históricas deben quedar asociadas al país de su subsidiaria.');

  const context=await one(`select u.email,ucs.session_id,au.id sub,ucs.subsidiary_id
    from public.user_company_sessions ucs
    join public.users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    where exists(select 1 from public.locations l join public.location_subsidiaries ls using(location_id) where ls.subsidiary_id=ucs.subsidiary_id)
      and exists(select 1 from public.fiscal_periods fp where fp.subsidiary_id=ucs.subsidiary_id and not coalesce(fp.is_inactive,false))
      and (select count(*) from public.chart_accounts a join public.account_subsidiaries s using(account_id) where s.subsidiary_id=ucs.subsidiary_id and s.is_active and not coalesce(a.is_inactive,false) and coalesce(a.accepts_entries,true))>=2
    order by ucs.selected_at desc
    limit 1`);
  assert.ok(context,'Se requiere una sesión con subsidiaria, período, ubicación y cuentas activas.');

  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
  const setup=await one(`select
    s.currency_id,
    tt.name pending_type,
    fp.fiscal_period_id,
    to_char(fp.start_date,'YYYY-MM-DD') journal_date,
    (select array_agg(account_id order by account_id) from (
      select a.account_id from public.chart_accounts a
      join public.account_subsidiaries link using(account_id)
      where link.subsidiary_id=s.subsidiary_id and link.is_active
        and not coalesce(a.is_inactive,false) and coalesce(a.accepts_entries,true)
      order by a.account_id limit 2
    ) accounts) account_ids,
    (select array_agg(country_id order by country_id) from (
      select country_id from public.countries order by country_id limit 2
    ) countries) country_ids
  from public.subsidiaries s
  cross join lateral(
    select fiscal_period_id,start_date from public.fiscal_periods
    where subsidiary_id=s.subsidiary_id and not coalesce(is_inactive,false)
    order by start_date desc limit 1
  ) fp
  cross join public.transaction_types tt
  where s.subsidiary_id=$1 and tt.abbreviation='ASI_PEN'`,[context.subsidiary_id]);
  assert.equal(setup.account_ids.length,2);
  assert.ok(setup.country_ids.length>=1);

  const countryA=setup.country_ids[0],countryB=setup.country_ids[1]||countryA;
  const line=(account_id,debit,credit,country)=>({
    account_id,debit,credit,tax_code_id:'',tax_rate:'',gross_amount:Math.max(debit,credit),
    service_month:String(setup.journal_date).slice(0,7),service_country_id:country,note:'Prueba reversible',
    entity_type:'',entity_id:'',department_id:'',class_id:'',cost_center_id:'',financial_creditor_id:'',related_company_id:''
  });
  const payload={
    journal_type:setup.pending_type,journal_date:setup.journal_date,fiscal_period_id:setup.fiscal_period_id,
    currency_id:setup.currency_id,exchange_rate:1,memo:'Prueba reversible País de servicio',
    lines:[line(setup.account_ids[0],10,0,countryA),line(setup.account_ids[1],0,10,countryA)]
  };

  const country=await one('select country_id,name,country_code_iso2 from public.countries where country_id=$1',[countryA]);
  const csvLine={tipo_asiento:'ASI_PEN',pais_servicio:country.country_code_iso2||country.name,entidad:'',nombre:'',departamento:'',centro_costos:'',clase:'',acreedor_financiero:'',compania_relacionada:''};
  const csvResolved=await one('select public.journal_csv_dimensions($1::jsonb) value',[JSON.stringify(csvLine)]);
  assert.equal(String(csvResolved.value.service_country_id),String(countryA));
  await db.query('savepoint csv_missing_country');
  await assert.rejects(
    db.query('select public.journal_csv_dimensions($1::jsonb)',[JSON.stringify({...csvLine,pais_servicio:''})]),
    /País de servicio es obligatorio/
  );
  await db.query('rollback to savepoint csv_missing_country');

  await db.query('set local role authenticated');
  const created=await one('select public.create_journal_entry($1::jsonb) journal_id',[JSON.stringify(payload)]);
  let stored=(await db.query('select service_country_id from public.journal_line where journal_id=$1 order by journal_line_id',[created.journal_id])).rows;
  assert.deepEqual(stored.map(row=>String(row.service_country_id)),[String(countryA),String(countryA)]);

  payload.lines=payload.lines.map(item=>({...item,service_country_id:countryB,note:'País actualizado'}));
  await db.query('select public.update_journal_entry($1,$2::jsonb)',[created.journal_id,JSON.stringify(payload)]);
  stored=(await db.query('select service_country_id from public.journal_line where journal_id=$1 order by journal_line_id',[created.journal_id])).rows;
  assert.deepEqual(stored.map(row=>String(row.service_country_id)),[String(countryB),String(countryB)]);

  await db.query('savepoint missing_country');
  await assert.rejects(
    db.query('select public.create_journal_entry($1::jsonb)',[JSON.stringify({...payload,lines:payload.lines.map(item=>({...item,service_country_id:''}))})]),
    /País de servicio válido/
  );
  await db.query('rollback to savepoint missing_country');

  const standard={...payload,journal_type:'Estándar',memo:'País no aplicable en diario general'};
  const standardCreated=await one('select public.create_journal_entry($1::jsonb) journal_id',[JSON.stringify(standard)]);
  stored=(await db.query('select service_country_id from public.journal_line where journal_id=$1 order by journal_line_id',[standardCreated.journal_id])).rows;
  assert.ok(stored.every(row=>row.service_country_id===null));

  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({
    migration:installed.value?'already-installed':'validated-with-rollback',
    created:true,edited:true,requiredForPending:true,ignoredForOtherTypes:true,csvCountryLookup:true,historicalBackfill:true,rollback:true
  }));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
