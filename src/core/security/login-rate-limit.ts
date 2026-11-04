import {createHash} from 'node:crypto';

type Attempt = {failures:number[];lockedUntil:number;expiresAt:number};
type AttemptStore = {entries:Map<string,Attempt>;capacity:number;failureLimit:number;failureCount:number};
export type LoginRateLimiterOptions = {
  clock?:()=>number;
  enableIpAggregate?:boolean|(()=>boolean);
  maxPairs?:number;
  maxIps?:number;
  cleanupBatchSize?:number;
};
const WINDOW_MS=15*60*1000;
const MAX_PAIRS=10_000;
const MAX_IPS=10_000;
const CLEANUP_BATCH=32;
const MAX_CLEANUP_BATCH=128;

export class LoginRateLimitError extends Error {
  readonly status=429;
  constructor(readonly retryAfterSeconds:number){
    super(`Demasiados intentos de acceso. Intente nuevamente en ${Math.ceil(retryAfterSeconds/60)} minuto(s).`);
    this.name='LoginRateLimitError';
  }
}
function boundedOption(value:number|undefined,fallback:number,maximum:number){
  const selected=value??fallback;
  if(!Number.isSafeInteger(selected)||selected<1||selected>maximum)throw new RangeError('Capacidad del limitador de acceso inválida.');
  return selected;
}
function identity(ip:string|null|undefined,email:unknown){
  const address=typeof ip==='string'&&ip.length<=128?ip.trim().toLowerCase()||'unknown':'unknown';
  // Normalize only bounded input. Oversized/invalid inputs share a fixed bucket
  // instead of retaining attacker-controlled strings or allocating large keys.
  let account='unknown';
  if(typeof email==='string'){
    account=email.length<=1024?email.trim().toLowerCase():'<oversized-email>';
    if(account.length>254)account='<oversized-email>';
  }
  const ipKey=createHash('sha256').update(address).digest('hex');
  const pairKey=createHash('sha256').update(ipKey).update('\0').update(account).digest('hex');
  return{ipKey,pairKey};
}

/** Local per-process protection. Shared limits across workers/replicas (M01)
 * still require a separate distributed store. IP aggregation is opt-in: B07
 * ingress/proxy trust remains pending, and 100 failures can affect shared NAT.
 * The limiter itself has no timer, environment access or IO.
 */
export class LocalLoginRateLimiter {
  private readonly clock:()=>number;
  private readonly ipAggregateEnabled:()=>boolean;
  private readonly cleanupBatchSize:number;
  private readonly pairs:AttemptStore;
  private readonly ips:AttemptStore;
  private lastNow=Number.NEGATIVE_INFINITY;
  constructor(options:LoginRateLimiterOptions={}){
    this.clock=options.clock??Date.now;
    const aggregate=options.enableIpAggregate??false;
    this.ipAggregateEnabled=typeof aggregate==='function'?aggregate:()=>aggregate;
    this.cleanupBatchSize=boundedOption(options.cleanupBatchSize,CLEANUP_BATCH,MAX_CLEANUP_BATCH);
    this.pairs={entries:new Map(),capacity:boundedOption(options.maxPairs,MAX_PAIRS,MAX_PAIRS),failureLimit:5,failureCount:0};
    // Shared NAT/proxy users share this budget; capacity saturation also fails
    // closed rather than evicting an active lock to admit another identity.
    this.ips={entries:new Map(),capacity:boundedOption(options.maxIps,MAX_IPS,MAX_IPS),failureLimit:100,failureCount:0};
  }
  private time(value?:number){
    const now=value??this.clock();
    if(!Number.isSafeInteger(now)||Math.abs(now)>Number.MAX_SAFE_INTEGER-WINDOW_MS)throw new RangeError('Reloj del limitador de acceso inválido.');
    this.lastNow=Math.max(this.lastNow,now);
    return this.lastNow;
  }
  private remove(store:AttemptStore,id:string,entry:Attempt){
    store.entries.delete(id);store.failureCount-=entry.failures.length;
  }
  private cleanup(store:AttemptStore,now:number){
    // Entries move to the end only on a recorded failure. Monotonic timestamps
    // and one common TTL keep this order sorted by expiry; no full-map scan.
    for(let checked=0;checked<this.cleanupBatchSize;checked++){
      const first=store.entries.entries().next();
      if(first.done||first.value[1].expiresAt>now)break;
      this.remove(store,first.value[0],first.value[1]);
    }
  }
  private active(store:AttemptStore,id:string,now:number){
    const entry=store.entries.get(id);
    if(!entry)return undefined;
    if(entry.expiresAt<=now){this.remove(store,id,entry);return undefined;}
    let expired=0;
    while(expired<entry.failures.length&&entry.failures[expired]<=now-WINDOW_MS)expired++;
    if(expired){entry.failures.splice(0,expired);store.failureCount-=expired;}
    return entry;
  }
  private retry(until:number,now:number):never{throw new LoginRateLimitError(Math.max(1,Math.ceil((until-now)/1000)));}
  private capacity(pair:Attempt|undefined,ip:Attempt|undefined,now:number,aggregate:boolean){
    let until=Number.NEGATIVE_INFINITY;
    for(const[store,entry]of[[this.pairs,pair],[this.ips,ip]]as const){
      if(store===this.ips&&!aggregate)continue;
      if(!entry&&store.entries.size>=store.capacity){
        const oldest=store.entries.values().next().value;
        if(oldest)until=Math.max(until,oldest.expiresAt);
      }
    }
    if(until>now)this.retry(until,now);
  }
  private record(store:AttemptStore,id:string,entry:Attempt|undefined,now:number){
    if(entry&&entry.lockedUntil>now)return;
    const current=entry??{failures:[],lockedUntil:0,expiresAt:0};
    // Each array is permanently bounded at five (pair) or 100 (IP) timestamps.
    if(current.failures.length<store.failureLimit){current.failures.push(now);store.failureCount++;}
    if(current.failures.length>=store.failureLimit)current.lockedUntil=now+WINDOW_MS;
    current.expiresAt=now+WINDOW_MS;
    store.entries.delete(id);store.entries.set(id,current);
  }
  assertLoginAllowed(ip:string|null|undefined,email:unknown,now?:number){
    const timestamp=this.time(now);this.cleanup(this.pairs,timestamp);this.cleanup(this.ips,timestamp);
    const aggregate=this.ipAggregateEnabled()===true;
    const ids=identity(ip,email),pair=this.active(this.pairs,ids.pairKey,timestamp),address=aggregate?this.active(this.ips,ids.ipKey,timestamp):undefined;
    const lockedUntil=Math.max(pair?.lockedUntil??0,address?.lockedUntil??0);
    if(lockedUntil>timestamp)this.retry(lockedUntil,timestamp);
    this.capacity(pair,address,timestamp,aggregate);
    // An allowed assertion never reserves an empty pair or IP entry.
  }
  recordLoginFailure(ip:string|null|undefined,email:unknown,now?:number){
    const timestamp=this.time(now);this.cleanup(this.pairs,timestamp);this.cleanup(this.ips,timestamp);
    const aggregate=this.ipAggregateEnabled()===true;
    const ids=identity(ip,email),address=aggregate?this.active(this.ips,ids.ipKey,timestamp):undefined;
    // In-flight failures after an IP block neither extend it nor allocate pairs.
    if(address&&address.lockedUntil>timestamp)return;
    const pair=this.active(this.pairs,ids.pairKey,timestamp);
    this.capacity(pair,address,timestamp,aggregate);
    if(aggregate)this.record(this.ips,ids.ipKey,address,timestamp);
    this.record(this.pairs,ids.pairKey,pair,timestamp);
  }
  clearLoginFailures(ip:string|null|undefined,email:unknown){
    const id=identity(ip,email).pairKey,entry=this.pairs.entries.get(id);
    if(entry)this.remove(this.pairs,id,entry);
    // A successful login cannot erase spraying history shared by the same IP.
  }
  /** Aggregate operational metrics; never exposes IPs, emails or their hashes. */
  getStats(){
    return{pairEntries:this.pairs.entries.size,ipEntries:this.ips.entries.size,
      pairFailures:this.pairs.failureCount,ipFailures:this.ips.failureCount,
      pairCapacity:this.pairs.capacity,ipCapacity:this.ips.capacity};
  }
}
export function createLoginRateLimiter(options:LoginRateLimiterOptions={}){return new LocalLoginRateLimiter(options);}
// Mirror clientIp's existing trust flag per operation. Do not enable proxy
// trust here: without it, Railway's socket may group unrelated clients.
const limiter=createLoginRateLimiter({enableIpAggregate:()=>process.env.TRUST_CLOUDFLARE_PROXY?.trim().toLowerCase()==='true'});
export function assertLoginAllowed(ip:string|null|undefined,email:unknown,now?:number){limiter.assertLoginAllowed(ip,email,now);}
export function recordLoginFailure(ip:string|null|undefined,email:unknown,now?:number){limiter.recordLoginFailure(ip,email,now);}
export function clearLoginFailures(ip:string|null|undefined,email:unknown){limiter.clearLoginFailures(ip,email);}
