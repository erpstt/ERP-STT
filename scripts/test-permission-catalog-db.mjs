import pg from'pg';process.loadEnvFile?.('.env');const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await client.connect();try{
 const counts=(await client.query('select count(*)::int total,count(*)filter(where is_operational)::int operational from permissions')).rows[0];
 if(counts.total!==138||counts.operational!==31)throw new Error(`Clasificación inesperada: ${counts.total} totales, ${counts.operational} operativos.`);
 const policies=(await client.query("select tablename,cmd,coalesce(qual,'')||coalesce(with_check,'') expression from pg_policies where schemaname='public'and tablename in('permissions','role_permissions')and cmd in('INSERT','UPDATE','DELETE')")).rows;
 const definitions=policies.filter(policy=>policy.tablename==='permissions'),assignments=policies.filter(policy=>policy.tablename==='role_permissions');
 if(policies.length!==6||definitions.some(policy=>!policy.expression.includes('false'))||assignments.some(policy=>!policy.expression.includes('app_is_admin')))throw new Error('Las políticas de escritura del catálogo o sus asignaciones no son seguras.');
 const signatures=(await client.query("select pg_get_function_identity_arguments(p.oid)args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname='security_save_role_access_matrix'")).rows;
 if(signatures.length!==1||!signatures[0].args.includes('p_permission_ids bigint[]'))throw new Error('La función transaccional no tiene la firma integrada esperada.');
 console.log(`OK: ${counts.total} definiciones, ${counts.operational} operativas, RLS administrativo y guardado integrado verificados.`);
}finally{await client.end()}
