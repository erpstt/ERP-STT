import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const installed=await one(`select exists(select 1 from information_schema.columns where table_schema='public' and table_name='journal_line' and column_name='service_month') value`);
  if(!installed.value)await db.query(await readFile(new URL('../supabase/migrations/20261001100000_fix_pending_service_dimensions.sql',import.meta.url),'utf8'));

  const historical=await one(`select
    count(*) filter(where entry.journal_type='Asientos Pendientes de Facturar' or entry.journal_number like 'ASI_PEN-%')::int pending_lines,
    count(*) filter(where (entry.journal_type='Asientos Pendientes de Facturar' or entry.journal_number like 'ASI_PEN-%') and line.service_month is null)::int pending_month_missing,
    count(*) filter(where entry.journal_type='Reversión de Pendiente de Facturar')::int reversal_lines,
    count(*) filter(where entry.journal_type='Reversión de Pendiente de Facturar' and (line.service_month is null or line.service_country_id is null))::int reversal_dimensions_missing
    from public.journal entry join public.journal_line line using(journal_id)`);
  assert.ok(historical.pending_lines>0);
  assert.equal(historical.pending_month_missing,0);
  assert.equal(historical.reversal_dimensions_missing,0);

  const source=await one(`select entry.journal_id,entry.subsidiary_id,entry.pending_balance_local
    from public.journal entry
    where (entry.journal_type='Asientos Pendientes de Facturar' or entry.journal_number like 'ASI_PEN-%')
      and entry.status='CONTABILIZADO' and entry.pending_balance_local>0
      and exists(select 1 from public.fiscal_periods period where period.subsidiary_id=entry.subsidiary_id and not period.is_closed and not coalesce(period.gl_closed,false) and not coalesce(period.is_inactive,false))
    order by entry.journal_id desc limit 1`);
  assert.ok(source,'Se requiere un ASI_PEN con saldo para probar la reversión.');

  const context=await one(`select u.email,session.session_id,auth_user.id sub,session.subsidiary_id
    from public.user_company_sessions session
    join public.users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    where session.subsidiary_id=$1
      and exists(select 1 from public.user_roles ur join public.role_permissions rp using(role_id) join public.permissions permission using(permission_id) where ur.user_id=u.user_id and permission.code='accounting:journal:reverse')
    order by session.selected_at desc limit 1`,[source.subsidiary_id]);
  assert.ok(context,'Se requiere una sesión autorizada para reversar ASI_PEN.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);

  const setup=await one(`select subsidiary.currency_id,pending_type.name pending_type,
      period.fiscal_period_id,to_char(period.start_date,'YYYY-MM-DD') journal_date,
      to_char(greatest(period.start_date,least(period.end_date,current_date)),'YYYY-MM-DD') reversal_date,
      (select array_agg(account_id order by account_id) from(select account.account_id from public.chart_accounts account join public.account_subsidiaries link using(account_id) where link.subsidiary_id=subsidiary.subsidiary_id and link.is_active and not coalesce(account.is_inactive,false) and coalesce(account.accepts_entries,true) order by account.account_id limit 2) chosen_accounts) account_ids,
      (select country_id from public.countries order by country_id limit 1) country_id
    from public.subsidiaries subsidiary
    cross join lateral(select fiscal_period_id,start_date,end_date from public.fiscal_periods where subsidiary_id=subsidiary.subsidiary_id and not is_closed and not coalesce(gl_closed,false) and not coalesce(is_inactive,false) order by start_date desc limit 1) period
    cross join public.transaction_types pending_type
    where subsidiary.subsidiary_id=$1 and pending_type.abbreviation='ASI_PEN'`,[source.subsidiary_id]);
  assert.equal(setup.account_ids.length,2);

  const makeLine=(account_id,debit,credit,month)=>({account_id,debit,credit,tax_code_id:'',tax_rate:'',gross_amount:Math.max(debit,credit),service_month:month,service_country_id:setup.country_id,note:'Prueba reversible de dimensiones',entity_type:'',entity_id:'',department_id:'',class_id:'',cost_center_id:'',financial_creditor_id:'',related_company_id:''});
  const payload={journal_type:setup.pending_type,journal_date:setup.journal_date,fiscal_period_id:setup.fiscal_period_id,currency_id:setup.currency_id,exchange_rate:1,memo:'Prueba reversible de mes y país',lines:[makeLine(setup.account_ids[0],10,0,'2026-04'),makeLine(setup.account_ids[1],0,10,'2026-04')]};

  await db.query('set local role authenticated');
  const created=await one('select public.create_journal_entry($1::jsonb) journal_id',[JSON.stringify(payload)]);
  let lines=(await db.query('select service_month,service_country_id from public.journal_line where journal_id=$1 order by journal_line_id',[created.journal_id])).rows;
  assert.deepEqual(lines.map(line=>line.service_month),['2026-04','2026-04']);

  payload.lines=payload.lines.map(line=>({...line,service_month:'2026-05'}));
  await db.query('select public.update_journal_entry($1,$2::jsonb)',[created.journal_id,JSON.stringify(payload)]);
  lines=(await db.query('select service_month,service_country_id from public.journal_line where journal_id=$1 order by journal_line_id',[created.journal_id])).rows;
  assert.deepEqual(lines.map(line=>line.service_month),['2026-05','2026-05']);

  payload.lines=payload.lines.map(({service_month,...line})=>line);
  await db.query('select public.update_journal_entry($1,$2::jsonb)',[created.journal_id,JSON.stringify(payload)]);
  lines=(await db.query('select service_month from public.journal_line where journal_id=$1 order by journal_line_id',[created.journal_id])).rows;
  assert.deepEqual(lines.map(line=>line.service_month),['2026-05','2026-05']);

  const reversed=await one('select public.reverse_pending_invoice_journal($1,$2::jsonb) value',[source.journal_id,JSON.stringify({reversalDate:setup.reversal_date,amount:Math.min(Number(source.pending_balance_local),1),type:'ERROR_CORRECCION',errorDescription:'Prueba reversible de dimensiones de servicio',supports:[]})]);
  const comparison=(await db.query(`with source as(select service_month,service_country_id,row_number() over(order by journal_line_id) n from public.journal_line where journal_id=$1),reversal as(select service_month,service_country_id,row_number() over(order by journal_line_id) n from public.journal_line where journal_id=$2) select source.service_month source_month,reversal.service_month reversal_month,source.service_country_id source_country,reversal.service_country_id reversal_country from source join reversal using(n) order by n`,[source.journal_id,reversed.value.journalId])).rows;
  assert.ok(comparison.length>0);
  for(const line of comparison){assert.equal(line.reversal_month,line.source_month);assert.equal(String(line.reversal_country),String(line.source_country));}

  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({migration:installed.value?'already-installed':'validated-with-rollback',createMonth:true,editMonth:true,legacyEditPreservesMonth:true,reversalCopiesMonth:true,reversalCopiesCountry:true,historicalBackfill:true,rollback:true}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{await db.end()}
