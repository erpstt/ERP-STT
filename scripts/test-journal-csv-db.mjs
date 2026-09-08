import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const local = process.argv.includes('--local');
let client;
if (local) {
  const { PGlite } = await import('../.tmp/journal-csv-test/node_modules/@electric-sql/pglite/dist/index.js');
  const db = new PGlite();
  await db.exec(await readFile(new URL('./journal-csv-test-fixture.sql',import.meta.url),'utf8'));
  client = { connect: async()=>{}, query: async(sql,params)=>params ? db.query(sql,params) : (await db.exec(sql)).at(-1), end: ()=>db.close() };
} else {
  process.loadEnvFile?.('.env');
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  if (!(process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD)) throw Error('Configure SUPABASE_DB_PASSWORD para ejecutar las pruebas de Supabase.');
  client = new pg.Client({ host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com', port: Number(process.env.SUPABASE_DB_PORT || 6543), database: 'postgres', user: process.env.SUPABASE_DB_USER || `postgres.${ref}`, password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
}
await client.connect();
try {
  await client.query('begin');
  await client.query(await readFile(new URL('../supabase/migrations/20260908120000_import_journal_csv.sql', import.meta.url),'utf8'));
  await client.query(await readFile(new URL('../supabase/migrations/20260908130000_journal_csv_dimensions.sql', import.meta.url),'utf8'));
  const context = (await client.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];
  assert.ok(context, 'Se requiere una sesión de prueba con subsidiaria activa.');
  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  const { sid, currency } = (await client.query('select s.subsidiary_id sid,c.currency_code currency from subsidiaries s join currencies c using(currency_id) where s.subsidiary_id=active_subsidiary_id()')).rows[0];
  const accounts = (await client.query('select a.account_number from chart_accounts a join account_subsidiaries s using(account_id) where s.subsidiary_id=$1 and s.is_active and not coalesce(a.is_inactive,false) and coalesce(a.accepts_entries,true) order by a.account_id limit 2',[sid])).rows;
  const { date } = (await client.query("select to_char(start_date,'YYYY-MM-DD') date from fiscal_periods where subsidiary_id=$1 and not coalesce(is_inactive,false) order by start_date desc limit 1",[sid])).rows[0];
  assert.equal(accounts.length,2);
  const base = { asiento_referencia: `TEST-${Date.now()}`, tipo_asiento:'ASI_DIA', fecha:date, moneda:currency, tipo_cambio:'1', nota_asiento:'Prueba reversible CSV', numero_cuenta:accounts[0].account_number, debito:'10.00', credito:'0.00', nota_linea:'Prueba', mes_servicio:'' };
  const rows = [base,{...base,numero_cuenta:accounts[1].account_number,debito:'0.00',credito:'10.00'}];
  const call = async (input, preview=true, company=sid) => (await client.query('select import_journal_csv($1::jsonb,$2,$3) result',[JSON.stringify(input),preview,company])).rows[0].result;
  const count = async () => Number((await client.query('select count(*) total from journal')).rows[0].total);
  const before = await count();
  if (local) {
    const dimensions={entidad:'Cliente',nombre:'Cliente prueba',departamento:'Servicios',centro_costos:'Proyecto',clase:'Consultoria',acreedor_financiero:'Banco prueba',compania_relacionada:'Relacionada prueba'};
    const resolved=(await client.query('select journal_csv_dimensions($1::jsonb) value',[JSON.stringify(dimensions)])).rows[0].value;
    assert.deepEqual(resolved,{entity_type:'Cliente',entity_id:10,department_id:'20',cost_center_id:'40',class_id:'30',financial_creditor_id:'50',related_company_id:'60'});
    const automatic=(await client.query('select journal_csv_dimensions($1::jsonb) value',[JSON.stringify({...dimensions,departamento:'',clase:''})])).rows[0].value;
    assert.deepEqual(automatic,resolved);
    assert.equal((await call(rows.map(r=>({...r,...dimensions})))).valid,true);
    for (const patch of [{nombre:'Cliente ajeno'},{nombre:''},{entidad:'Otro'},{entidad:'',nombre:'Cliente prueba'},{departamento:'Administracion'},{departamento:'Inactivo'},{centro_costos:'No existe'},{clase:'Otra clase'},{acreedor_financiero:'Duplicado'},{compania_relacionada:'No existe'}]) {
      assert.equal((await call(rows.map(r=>({...r,...dimensions,...patch})),false)).valid,false,JSON.stringify(patch));
    }
    assert.equal((await call(rows.map(r=>({...r,...dimensions,acreedor_financiero:'ID:51'})))).valid,true);
    for (const entity of [{entidad:'Proveedor',nombre:'Proveedor prueba'},{entidad:'Empleado',nombre:'Ana Prueba',departamento:'Administracion'}]) assert.equal((await call(rows.map(r=>({...r,...entity})))).valid,true);
  }
  await client.query('set local role authenticated');
  assert.equal((await call(rows)).valid,true);
  for (const patch of [{credito:'9'},{numero_cuenta:'NO-SUCH-ACCOUNT'},{fecha:'2026-02-30'},{tipo_cambio:'0'},{debito:'-1'},{debito:'NaN'},{debito:'1,00'},{moneda:'INVALID'},{mes_servicio:'2026-13'},{nota_asiento:'Different'},{debito:'1',credito:'1'}]) {
    const bad = [{...base,asiento_referencia:'INVALID'},{...rows[1],asiento_referencia:'INVALID',...patch}];
    const result = await call([...rows,...bad],false);
    assert.equal(result.valid,false,JSON.stringify(patch)); assert.equal(result.created,0);
  }
  await client.query('reset role');
  assert.equal(await count(),before);
  // Force an error during the second journal creation to verify database rollback.
  await client.query("create function pg_temp.reject_csv_test() returns trigger language plpgsql as $$begin if new.memo='FORCE_CSV_FAILURE' then raise exception 'Forced test failure'; end if; return new; end$$");
  await client.query('create trigger csv_rollback_test before insert on journal for each row execute function pg_temp.reject_csv_test()');
  await client.query('savepoint runtime_failure');
  await assert.rejects(call([...rows,...rows.map(r=>({...r,asiento_referencia:'FAIL',nota_asiento:'FORCE_CSV_FAILURE'}))],false), /No se guardó ningún asiento/);
  await client.query('rollback to savepoint runtime_failure');
  assert.equal(await count(),before);
  await client.query('drop trigger csv_rollback_test on journal');
  await client.query('set local role authenticated');
  const batch = [...rows,...rows.map(r=>({...r,asiento_referencia:`${base.asiento_referencia}-SECOND`}))];
  const saved = await call(batch,false); assert.equal(saved.created,2);
  const repeated = await call(batch,false); assert.equal(repeated.alreadyImported,true); assert.deepEqual(repeated.entries,saved.entries);
  await client.query('savepoint company_change');
  await assert.rejects(call(rows,false,Number(sid)+999999), /subsidiaria activa cambió/);
  await client.query('rollback to savepoint company_change');
  await client.query('reset role');
  assert.equal(await count(),before+2);
  const stored = (await client.query('select count(*)::int total,sum(debit) debit,sum(credit) credit from journal_line where journal_id=$1',[saved.entries[0].journalId])).rows[0];
  assert.equal(stored.total,2); assert.equal(Number(stored.debit),10); assert.equal(Number(stored.credit),10);
  if (!local) {
    const label=`CSV-TEST-${Date.now()}`;
    const dept=(await client.query("insert into departments(name,type) values($1,'Cliente') returning department_id",[label])).rows[0];
    const cls=(await client.query('insert into classes(name) values($1) returning class_id',[label])).rows[0];
    await client.query('insert into department_subsidiaries(department_id,subsidiary_id) values($1,$2)',[dept.department_id,sid]);
    await client.query('insert into class_subsidiaries(class_id,subsidiary_id) values($1,$2)',[cls.class_id,sid]);
    const customer=(await client.query('insert into customers(company_name,tax_id,primary_subsidiary_id,currency_id,department_id) select $1,$1,$2,currency_id,$3 from subsidiaries where subsidiary_id=$2 returning customer_id',[label,sid,dept.department_id])).rows[0];
    await client.query('insert into entity_subsidiaries(customer_id,subsidiary_id) values($1,$2)',[customer.customer_id,sid]);
    const center=(await client.query('insert into cost_centers(code,name,subsidiary_id,customer_id,class_id) values($1,$1,$2,$3,$4) returning cost_center_id',[label,sid,customer.customer_id,cls.class_id])).rows[0];
    const candidate={...dept,...cls,...customer,...center};
    const creditor=(await client.query('insert into financial_creditors(code,name,identification) values($1,$1,$1) returning financial_creditor_id id',[label])).rows[0];
    await client.query('insert into financial_creditor_subsidiaries(financial_creditor_id,subsidiary_id) values($1,$2)',[creditor.id,sid]);
    const related=(await client.query('insert into related_companies(code,name,identification,country_id) select $1,$1,$1,country_id from countries order by country_id limit 1 returning related_company_id id',[label])).rows[0];
    await client.query('insert into related_company_subsidiaries(related_company_id,subsidiary_id) values($1,$2)',[related.id,sid]);
    const dimensions={entidad:'Cliente',nombre:`ID:${candidate.customer_id}`,departamento:`ID:${candidate.department_id}`,centro_costos:`ID:${candidate.cost_center_id}`,clase:`ID:${candidate.class_id}`,acreedor_financiero:`ID:${creditor.id}`,compania_relacionada:`ID:${related.id}`};
    const extraRows=rows.map(r=>({...r,asiento_referencia:`${base.asiento_referencia}-DIMENSIONS`,...dimensions}));
    const preview=await call(extraRows); assert.equal(preview.valid,true,JSON.stringify(preview.errors));
    await client.query('set local role authenticated');
    const extraSaved=await call(extraRows,false); assert.equal(extraSaved.created,1,JSON.stringify(extraSaved.errors));
    await client.query('reset role');
    const extraLines=(await client.query('select entity_type,customer_id,department_id,cost_center_id,class_id,financial_creditor_id,related_company_id from journal_line where journal_id=$1',[extraSaved.entries[0].journalId])).rows;
    assert.equal(extraLines.length,2);
    for(const line of extraLines){assert.equal(line.entity_type,'Cliente');for(const key of ['customer_id','department_id','cost_center_id','class_id'])assert.equal(String(line[key]),String(candidate[key]));assert.equal(String(line.financial_creditor_id),String(creditor.id));assert.equal(String(line.related_company_id),String(related.id));}
    console.log('OK: all seven additional CSV columns persisted in journal lines in Supabase.');
  }
  console.log('OK: preview, validation, authenticated access, atomic rollback, creation, retry deduplication, subsidiary guard and stored balances. All test data rolled back.');
} finally { await client.query('rollback'); await client.end(); }
