const { Client } = require('pg');

(async () => {
  const client = new Client({
    host: 'db.kqepssgjfbdctchpiwuu.supabase.co',
    port: 5432,
    user: 'postgres',
    password: '0B0Hp2V8ZWnkTzOQ',
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  const sql = `
    create table if not exists public.paises (
      id bigint generated always as identity primary key,
      nombre text not null unique check (btrim(nombre) <> '')
    );

    alter table public.paises enable row level security;

    drop policy if exists "Authenticated users can read paises" on public.paises;
    create policy "Authenticated users can read paises"
      on public.paises
      for select
      to authenticated
      using (true);

    insert into public.paises (nombre)
    values
      ('Costa Rica'),
      ('México'),
      ('Colombia'),
      ('España'),
      ('Argentina'),
      ('Perú')
    on conflict (nombre) do nothing;
  `;

  await client.query(sql);
  const result = await client.query('select id, nombre from public.paises order by nombre asc');
  console.log(JSON.stringify(result.rows, null, 2));
  await client.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
