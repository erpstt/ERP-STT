import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

process.loadEnvFile?.('.env');
const key=process.env.SUPABASE_SERVICE_ROLE_KEY,url=process.env.SUPABASE_URL;
const ref=new URL(url).hostname.split('.')[0];
const headers={apikey:key,Authorization:`Bearer ${key}`};
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
const remove=prefixes=>fetch(`${url}/storage/v1/object/tax-calendar`,{method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefixes})});
await db.connect();
let pending=[];
try{
  pending=(await db.query("select name from storage.objects where bucket_id='tax-calendar'and name like 'smoke/%'")).rows.map(row=>row.name);
  if(pending.length){const cleanup=await remove(pending);assert.ok(cleanup.ok,await cleanup.text());pending=[];}
  const path=`smoke/${randomUUID()}/respaldo.pdf`;pending=[path];
  const upload=await fetch(`${url}/storage/v1/object/tax-calendar/${path}`,{method:'POST',headers:{...headers,'Content-Type':'application/pdf','x-upsert':'false'},body:Buffer.from('%PDF-1.4\nNEXO TAX CALENDAR\n%%EOF')});
  const uploadText=await upload.text();assert.ok(upload.ok,uploadText);
  const download=await fetch(`${url}/storage/v1/object/authenticated/tax-calendar/${path}`,{headers});
  const bytes=Buffer.from(await download.arrayBuffer());assert.ok(download.ok,bytes.toString());assert.match(bytes.toString('ascii'),/^%PDF-/);
  const deleted=await remove(pending),deletedText=await deleted.text();assert.ok(deleted.ok,deletedText);
  const remaining=Number((await db.query("select count(*)::int n from storage.objects where bucket_id='tax-calendar'and name=$1",[path])).rows[0].n);assert.equal(remaining,0);
  pending=[];
  await new Promise(resolve=>setTimeout(resolve,500));
  const missing=await fetch(`${url}/storage/v1/object/authenticated/tax-calendar/${path}?cacheBust=${randomUUID()}`,{headers:{...headers,'Cache-Control':'no-cache'}});assert.equal(missing.ok,false);
  console.log(JSON.stringify({privateBucket:true,upload:true,authenticatedDownload:true,delete:true,temporaryObjectsRemoved:true}));
}finally{
  if(pending.length)await remove(pending).catch(()=>{});
  await db.end();
}
