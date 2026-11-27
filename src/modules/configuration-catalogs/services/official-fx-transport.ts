import {getSupabaseConfig} from '../../../core/database/supabase.client.js';

type Country='GT'|'AR'|'PE';
/** Same official source through a separate authenticated egress; no rate writes. */
export async function officialFxRequest(country:Country,date:string,url:RequestInfo|URL,init:RequestInit={},request:typeof fetch=fetch):Promise<Response>{
 let original:Response|undefined,failure:unknown;
 try{original=await request(url,init);if(original.ok||![403,408,429,500,502,503,504,525].includes(original.status))return original;}catch(error){failure=error;}
 const config=getSupabaseConfig(),key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(config&&key){
  try{
   const response=await request(new URL('/functions/v1/official-fx-source',config.url),{method:'POST',headers:{Authorization:`Bearer ${key}`,apikey:key,'Content-Type':'application/json'},body:JSON.stringify({country,date}),signal:AbortSignal.timeout(25000)});
   if(!response.ok)throw Error('Official source relay unavailable');
   const payload=await response.json() as {country?:string;date?:string;upstreamStatus?:number;body?:string};
   if(payload.country!==country||payload.date!==date||payload.upstreamStatus!==200||typeof payload.body!=='string'||payload.body.length>1000000)throw Error('Invalid official source response');
   return new Response(payload.body,{status:200});
  }catch{/* Keep the original failure and the provider's existing bounded retries. */}
 }
 if(original)return original;
 throw failure instanceof Error?failure:Error('Official source unavailable');
}
