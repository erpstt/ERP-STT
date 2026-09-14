import pg from 'pg';
process.loadEnvFile?.('.env');
const reference = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({ host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com', port: Number(process.env.SUPABASE_DB_PORT || 6543), database: 'postgres', user: process.env.SUPABASE_DB_USER || `postgres.${reference}`, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  const result = await db.query(`
    select d.department_id,d.name,d.type,d.is_inactive,d.subsidiary_id,
      coalesce(array_agg(distinct ds.subsidiary_id) filter(where ds.subsidiary_id is not null),'{}') assigned_subsidiaries,
      count(distinct jl.journal_line_id) movement_lines,
      coalesce(sum((jl.credit-jl.debit)*j.exchange_rate),0) net_movement
    from departments d
    left join department_subsidiaries ds using(department_id)
    left join journal_line jl using(department_id)
    left join journal j using(journal_id)
    where upper(d.name) like '%PAGUS%'
    group by d.department_id,d.name,d.type,d.is_inactive,d.subsidiary_id
    order by d.department_id`);
  console.log(JSON.stringify(result.rows));
} finally { await db.end(); }
