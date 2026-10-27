import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000
});

const migration = await readFile(
  new URL('../supabase/migrations/20261026115000_bank_statement_active_subsidiary_rls.sql', import.meta.url),
  'utf8'
);
const optionsMigration = await readFile(
  new URL('../supabase/migrations/20261027180000_bank_statement_account_options.sql', import.meta.url),
  'utf8'
);

async function assume(identity, sessionId) {
  await db.query('reset role');
  await db.query(
    `select set_config('request.jwt.claims',$1,true),set_config('request.headers','{}',true)`,
    [JSON.stringify({
      role: 'authenticated',
      email: identity.email,
      sub: identity.authId,
      session_id: sessionId
    })]
  );
  await db.query('set local role authenticated');
}

async function expectDenied(statement, params = []) {
  await db.query('savepoint expected_denial');
  try {
    await db.query(statement, params);
    assert.fail('La operacion entre subsidiarias fue permitida.');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.equal(error.code, '42501');
  } finally {
    await db.query('rollback to savepoint expected_denial');
    await db.query('release savepoint expected_denial');
  }
}

async function createIdentity(label, nonce) {
  const authId = crypto.randomUUID();
  const email = `bank-statement-${label}-${nonce}@example.test`.toLowerCase();
  await db.query(
    `insert into auth.users(id,email,raw_app_meta_data) values($1,$2,'{}'::jsonb)`,
    [authId, email]
  );
  const account = (await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,'auth:'||$2,$2::uuid,$3,'Extractos',true)
    returning user_id
  `, [email, authId, label])).rows[0];
  return { authId, email, userId: account.user_id };
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  await db.query(migration);
  await db.query(optionsMigration);

  const nonce = crypto.randomUUID().replaceAll('-', '');
  const subsidiaries = (await db.query(`
    select subsidiary_id,country_id,currency_id
    from public.subsidiaries
    where country_id is not null and currency_id is not null
    order by subsidiary_id
    limit 2
  `)).rows;
  assert.equal(subsidiaries.length, 2, 'Se requieren dos subsidiarias para validar el aislamiento.');
  const [subsidiaryA, subsidiaryB] = subsidiaries;
  const ledgerAccount = (await db.query(`
    select account_id from public.chart_accounts order by account_id limit 1
  `)).rows[0];
  assert.ok(ledgerAccount, 'Se requiere una cuenta contable para crear las cuentas bancarias de prueba.');

  const banks = [];
  for (const [index, subsidiary] of subsidiaries.entries()) {
    banks.push((await db.query(`
      insert into public.banks(bank_code,bank_name,country_id)
      values($1,$2,$3)
      returning bank_id
    `, [
      `TBS${index}${nonce.slice(0, 10)}`,
      `Banco aislamiento ${index + 1} ${nonce.slice(0, 8)}`,
      subsidiary.country_id
    ])).rows[0]);
  }

  const bankAccounts = [];
  for (const [index, subsidiary] of subsidiaries.entries()) {
    bankAccounts.push((await db.query(`
      insert into public.bank_account(
        account_number,bank_id,subsidiary_id,currency_id,account_id,balance,country_id
      ) values($1,$2,$3,$4,$5,0,$6)
      returning bank_account_id
    `, [
      `TEST-${index + 1}-${nonce.slice(0, 16)}`,
      banks[index].bank_id,
      subsidiary.subsidiary_id,
      subsidiary.currency_id,
      ledgerAccount.account_id,
      subsidiary.country_id
    ])).rows[0]);
  }
  const [bankAccountA, bankAccountB] = bankAccounts;

  const statementA = (await db.query(`
    insert into public.bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name)
    values('2099-01-31',$1,100,125,'subsidiaria-a.csv')
    returning statement_id
  `, [bankAccountA.bank_account_id])).rows[0];
  const statementB = (await db.query(`
    insert into public.bank_statement(statement_date,bank_account_id,opening_balance,closing_balance,source_file_name)
    values('2099-01-31',$1,200,230,'subsidiaria-b.csv')
    returning statement_id
  `, [bankAccountB.bank_account_id])).rows[0];
  const lineA = (await db.query(`
    insert into public.bank_statement_line(statement_id,bank_date,reference,amount,source_row)
    values($1,'2099-01-15','A-1',25,1)
    returning statement_line_id
  `, [statementA.statement_id])).rows[0];
  const lineB = (await db.query(`
    insert into public.bank_statement_line(statement_id,bank_date,reference,amount,source_row)
    values($1,'2099-01-15','B-1',30,1)
    returning statement_line_id
  `, [statementB.statement_id])).rows[0];

  const administratorRole = (await db.query(`
    select role_id
    from public.roles
    where lower(btrim(role_name)) in('administrador','administrator','admin')
    order by case lower(btrim(role_name)) when 'administrador' then 0 else 1 end,role_id
    limit 1
  `)).rows[0];
  assert.ok(administratorRole, 'Se requiere el rol Administrador para esta prueba.');
  const viewerRole = (await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Consulta de extractos sin permisos de escritura',false)
    returning role_id
  `, [`TEST-BANK-STATEMENT-VIEW-${nonce}`])).rows[0];
  await db.query(`
    insert into public.role_access_matrix(
      role_id,resource_key,can_view,can_create,can_edit,can_delete
    ) values($1,'banking:bank-statements',true,false,false,false)
  `, [viewerRole.role_id]);

  const administrator = await createIdentity('Administrador', nonce);
  const viewer = await createIdentity('Consulta', nonce);
  await db.query(`
    insert into public.user_roles(user_id,role_id)
    values($1,$2),($3,$4)
  `, [
    administrator.userId, administratorRole.role_id,
    viewer.userId, viewerRole.role_id
  ]);
  await db.query(`
    insert into public.user_subsidiaries(user_id,subsidiary_id)
    values($1,$2),($1,$3),($4,$2),($4,$3)
  `, [
    administrator.userId, subsidiaryA.subsidiary_id, subsidiaryB.subsidiary_id,
    viewer.userId
  ]);

  const adminSessionA = `bank-admin-a-${nonce}`;
  const adminSessionB = `bank-admin-b-${nonce}`;
  const viewerSessionA = `bank-view-a-${nonce}`;
  await db.query(`
    insert into public.user_role_sessions(session_id,user_id,role_id)
    values($1,$2,$3),($4,$2,$3),($5,$6,$7)
  `, [
    adminSessionA, administrator.userId, administratorRole.role_id,
    adminSessionB,
    viewerSessionA, viewer.userId, viewerRole.role_id
  ]);
  await db.query(`
    insert into public.user_company_sessions(session_id,user_id,subsidiary_id)
    values($1,$2,$3),($4,$2,$5),($6,$7,$3)
  `, [
    adminSessionA, administrator.userId, subsidiaryA.subsidiary_id,
    adminSessionB, subsidiaryB.subsidiary_id,
    viewerSessionA, viewer.userId
  ]);

  await assume(administrator, adminSessionA);
  assert.deepEqual(
    (await db.query(`
      select bank_account_id,subsidiary_id,bank_name,account_number,currency_code
      from public.bank_statement_account_options()
      where bank_account_id=any($1::bigint[])
    `, [[bankAccountA.bank_account_id, bankAccountB.bank_account_id]])).rows.map(row => ({
      ...row,
      bank_account_id: Number(row.bank_account_id),
      subsidiary_id: Number(row.subsidiary_id)
    })),
    [{
      bank_account_id: Number(bankAccountA.bank_account_id),
      subsidiary_id: Number(subsidiaryA.subsidiary_id),
      bank_name: `Banco aislamiento 1 ${nonce.slice(0, 8)}`,
      account_number: `TEST-1-${nonce.slice(0, 16)}`,
      currency_code: (await db.query('select currency_code from public.currencies where currency_id=$1',[subsidiaryA.currency_id])).rows[0].currency_code
    }]
  );
  assert.deepEqual(
    (await db.query(`
      select statement_id from public.bank_statement
      where statement_id=any($1::bigint[])
      order by statement_id
    `, [[statementA.statement_id, statementB.statement_id]])).rows,
    [{ statement_id: statementA.statement_id }]
  );
  assert.deepEqual(
    (await db.query(`
      select statement_line_id from public.bank_statement_line
      where statement_line_id=any($1::bigint[])
      order by statement_line_id
    `, [[lineA.statement_line_id, lineB.statement_line_id]])).rows,
    [{ statement_line_id: lineA.statement_line_id }]
  );
  assert.equal((await db.query(`
    update public.bank_statement set closing_balance=999
    where statement_id=$1 returning statement_id
  `, [statementB.statement_id])).rowCount, 0);
  assert.equal((await db.query(`
    delete from public.bank_statement where statement_id=$1 returning statement_id
  `, [statementB.statement_id])).rowCount, 0);
  await expectDenied(`
    insert into public.bank_statement(statement_date,bank_account_id,opening_balance,closing_balance)
    values('2099-02-28',$1,0,1)
  `, [bankAccountB.bank_account_id]);

  const disposable = (await db.query(`
    insert into public.bank_statement(statement_date,bank_account_id,opening_balance,closing_balance)
    values('2099-02-28',$1,125,130)
    returning statement_id
  `, [bankAccountA.bank_account_id])).rows[0];
  assert.equal((await db.query(`
    update public.bank_statement set closing_balance=131
    where statement_id=$1 returning statement_id
  `, [disposable.statement_id])).rowCount, 1);
  const disposableLine = (await db.query(`
    insert into public.bank_statement_line(statement_id,bank_date,reference,amount,source_row)
    values($1,'2099-02-15','A-2',6,1)
    returning statement_line_id
  `, [disposable.statement_id])).rows[0];
  assert.ok(disposableLine.statement_line_id);
  assert.equal((await db.query(`
    delete from public.bank_statement where statement_id=$1 returning statement_id
  `, [disposable.statement_id])).rowCount, 1);

  await assume(administrator, adminSessionB);
  assert.deepEqual(
    (await db.query(`
      select bank_account_id from public.bank_statement_account_options()
      where bank_account_id=any($1::bigint[])
    `, [[bankAccountA.bank_account_id, bankAccountB.bank_account_id]])).rows,
    [{ bank_account_id: bankAccountB.bank_account_id }]
  );
  assert.deepEqual(
    (await db.query(`
      select statement_id from public.bank_statement
      where statement_id=any($1::bigint[])
      order by statement_id
    `, [[statementA.statement_id, statementB.statement_id]])).rows,
    [{ statement_id: statementB.statement_id }]
  );
  assert.deepEqual(
    (await db.query(`
      select statement_line_id from public.bank_statement_line
      where statement_line_id=any($1::bigint[])
      order by statement_line_id
    `, [[lineA.statement_line_id, lineB.statement_line_id]])).rows,
    [{ statement_line_id: lineB.statement_line_id }]
  );

  await assume(viewer, viewerSessionA);
  assert.deepEqual(
    (await db.query(`
      select statement_id from public.bank_statement
      where statement_id=any($1::bigint[])
      order by statement_id
    `, [[statementA.statement_id, statementB.statement_id]])).rows,
    [{ statement_id: statementA.statement_id }]
  );
  assert.equal((await db.query(`
    update public.bank_statement set closing_balance=777
    where statement_id=$1 returning statement_id
  `, [statementA.statement_id])).rowCount, 0);
  assert.equal((await db.query(`
    delete from public.bank_statement where statement_id=$1 returning statement_id
  `, [statementA.statement_id])).rowCount, 0);
  assert.equal((await db.query(`
    update public.bank_statement_line set description='No permitido'
    where statement_line_id=$1 returning statement_line_id
  `, [lineA.statement_line_id])).rowCount, 0);
  assert.equal((await db.query(`
    delete from public.bank_statement_line where statement_line_id=$1 returning statement_line_id
  `, [lineA.statement_line_id])).rowCount, 0);
  await expectDenied(`
    insert into public.bank_statement(statement_date,bank_account_id,opening_balance,closing_balance)
    values('2099-03-31',$1,0,1)
  `, [bankAccountA.bank_account_id]);
  await expectDenied(`
    insert into public.bank_statement_line(statement_id,bank_date,reference,amount,source_row)
    values($1,'2099-03-15','VIEW-1',1,2)
  `, [statementA.statement_id]);

  await db.query('rollback');
  console.log(JSON.stringify({
    administratorScopedToActiveSubsidiary: true,
    companySwitchChangesVisibility: true,
    accountOptionsScopedToActiveSubsidiary: true,
    statementLinesScopedWithHeader: true,
    roleActionsRechecked: true,
    crossSubsidiaryWritesBlocked: true,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
