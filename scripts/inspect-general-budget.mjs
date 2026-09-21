import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{console.log(JSON.stringify((await db.query("select h.id,h.nombre_version,h.estado,count(l.id) lines,count(l.id)filter(where l.id_centro_costo is not null or l.id_proyecto is not null) dimensional_lines from presupuestos_encabezado h left join presupuestos_lineas l on l.id_presupuesto_encabezado=h.id group by h.id order by h.id")).rows));}finally{await db.end()}
