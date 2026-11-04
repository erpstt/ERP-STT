import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {createLoginRateLimiter,LoginRateLimitError} from '../dist/core/security/login-rate-limit.js';

const windowMs=15*60*1000;
function fixture(options={}){
 let now=0;
 const limiter=createLoginRateLimiter({clock:()=>now,enableIpAggregate:true,...options});
 return{limiter,setTime:value=>{now=value;}};
}
function limited(work,seconds){
 assert.throws(work,error=>error instanceof LoginRateLimitError&&error.status===429&&Number.isInteger(error.retryAfterSeconds)&&error.retryAfterSeconds>0&&(seconds===undefined||error.retryAfterSeconds===seconds));
}
const failures=(limiter,ip,email,count)=>{for(let i=0;i<count;i++)limiter.recordLoginFailure(ip,email);};
function facadeProbe(code,flag,args=[]){
 const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 if(flag!==undefined)env.TRUST_CLOUDFLARE_PROXY=flag;
 const preloader=new URL('./fixtures/operator-no-live-io.mjs',import.meta.url).href;
 const moduleUrl=new URL('../dist/core/security/login-rate-limit.js',import.meta.url).href;
 const result=spawnSync(process.execPath,['--import',preloader,'--input-type=module','-e',code,moduleUrl,...args],{env,encoding:'utf8',timeout:10000});
 if(result.error)throw result.error;
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
}

test('successful assertions and unknown clears never allocate empty entries, including large attacker input',()=>{
 const {limiter}=fixture({maxPairs:2,maxIps:2});
 for(let i=0;i<1500;i++){
  limiter.assertLoginAllowed('192.0.2.1','synthetic-'+i+'@example.invalid');
  limiter.clearLoginFailures('192.0.2.2','synthetic-'+i+'@example.invalid');
 }
 limiter.assertLoginAllowed('192.0.2.1','x'.repeat(16*1024));
 assert.deepEqual(limiter.getStats(),{pairEntries:0,ipEntries:0,pairFailures:0,ipFailures:0,pairCapacity:2,ipCapacity:2});
});

test('five failures preserve the original pair lock for fifteen minutes from the fifth failure',()=>{
 const {limiter,setTime}=fixture();
 for(let i=0;i<5;i++){
  setTime(i*1000);limiter.assertLoginAllowed('192.0.2.1','user@example.invalid');
  limiter.recordLoginFailure('192.0.2.1','user@example.invalid');
 }
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'),900);
 setTime(windowMs+3000);limited(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'),1);
 setTime(windowMs+4000);assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'));
 assert.equal(limiter.getStats().pairEntries,0);assert.equal(limiter.getStats().ipEntries,0);
});

test('failures outside the sliding window expire and never accumulate into a lifetime lock',()=>{
 const {limiter,setTime}=fixture();failures(limiter,'192.0.2.1','user@example.invalid',4);
 setTime(windowMs);limiter.recordLoginFailure('192.0.2.1','user@example.invalid');
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'));
 assert.equal(limiter.getStats().pairFailures,1);assert.equal(limiter.getStats().ipFailures,1);
});

test('100 failed logins across different emails block the IP while other IPs remain independent',()=>{
 const {limiter}=fixture({maxPairs:110,maxIps:3});
 for(let i=0;i<100;i++){
  limiter.assertLoginAllowed('192.0.2.1','spray-'+i+'@example.invalid');
  limiter.recordLoginFailure('192.0.2.1','spray-'+i+'@example.invalid');
 }
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','new-account@example.invalid'),900);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','spray-0@example.invalid'),900);
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.2','spray-0@example.invalid'));
 limiter.recordLoginFailure('192.0.2.2','spray-0@example.invalid');
 assert.equal(limiter.getStats().ipEntries,2);assert.equal(limiter.getStats().ipFailures,101);
});

test('IP aggregation defaults off so a shared proxy cannot turn cross-account failures into a global block',()=>{
 const limiter=createLoginRateLimiter({clock:()=>0,maxPairs:200,maxIps:1});
 for(let i=0;i<150;i++)limiter.recordLoginFailure('192.0.2.1','shared-proxy-'+i+'@example.invalid');
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','unrelated@example.invalid'));
 assert.equal(limiter.getStats().ipEntries,0);assert.equal(limiter.getStats().ipFailures,0);
 failures(limiter,'192.0.2.1','shared-proxy-0@example.invalid',4);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','shared-proxy-0@example.invalid'),900);
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','shared-proxy-1@example.invalid'));
});

test('disabled aggregation retains hard pair capacity and TTL while allocating no IP state across different IPs',()=>{
 const {limiter,setTime}=fixture({enableIpAggregate:false,maxPairs:2,maxIps:1});
 limiter.recordLoginFailure('192.0.2.1','first@example.invalid');limiter.recordLoginFailure('192.0.2.2','second@example.invalid');
 assert.equal(limiter.getStats().ipEntries,0);assert.equal(limiter.getStats().pairEntries,2);
 limited(()=>limiter.assertLoginAllowed('192.0.2.3','third@example.invalid'),900);
 limited(()=>limiter.recordLoginFailure('192.0.2.3','third@example.invalid'),900);
 setTime(windowMs);limiter.recordLoginFailure('192.0.2.3','third@example.invalid');
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().ipEntries,0);
});

test('application facade enables the aggregate only for the existing proxy flag parsed exactly like clientIp',()=>{
 const code="import assert from 'node:assert/strict';const limiter=await import(process.argv[1]);for(let i=0;i<100;i++)limiter.recordLoginFailure('192.0.2.1','synthetic-'+i+'@example.invalid',0);let blocked=false;try{limiter.assertLoginAllowed('192.0.2.1','new@example.invalid',0);}catch(error){assert.equal(error.status,429);blocked=true;}assert.equal(blocked,process.argv[2]==='true');";
 for(const [flag,enabled]of[['true',true],[' TrUe ',true],[undefined,false],['',false],['false',false],['1',false],['yes',false]])facadeProbe(code,flag,[String(enabled)]);
});

test('facade rechecks proxy trust per operation so disabling trust never retains a shared-IP rejection',()=>{
 const code="import assert from 'node:assert/strict';const limiter=await import(process.argv[1]);const trust=value=>Object.defineProperty(process.env,'TRUST_CLOUDFLARE_PROXY',{value,writable:true,enumerable:true,configurable:true});for(let i=0;i<99;i++)limiter.recordLoginFailure('192.0.2.1','synthetic-'+i+'@example.invalid',0);trust('false');assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','while-off@example.invalid',0));limiter.recordLoginFailure('192.0.2.1','while-off@example.invalid',0);trust('true');limiter.recordLoginFailure('192.0.2.1','hundredth@example.invalid',0);assert.throws(()=>limiter.assertLoginAllowed('192.0.2.1','blocked@example.invalid',0),error=>error.status===429);trust('false');assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','unrelated@example.invalid',0));limiter.clearLoginFailures('192.0.2.1','hundredth@example.invalid');trust('true');assert.throws(()=>limiter.assertLoginAllowed('192.0.2.1','blocked-again@example.invalid',0),error=>error.status===429);";
 facadeProbe(code,'true');
});

test('a successful login clears only its pair and preserves another pair lock and the IP history',()=>{
 const {limiter}=fixture();failures(limiter,'192.0.2.1','first@example.invalid',5);failures(limiter,'192.0.2.1','second@example.invalid',5);
 limiter.clearLoginFailures('192.0.2.1','first@example.invalid');
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','first@example.invalid'));
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','second@example.invalid'),900);
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().pairFailures,5);assert.equal(limiter.getStats().ipFailures,10);
});

test('repeated successes cannot reset spraying history and the IP recovers only after expiry',()=>{
 const {limiter,setTime}=fixture({maxPairs:2,maxIps:2});
 for(let i=0;i<100;i++){
  const email='synthetic-'+i+'@example.invalid';limiter.recordLoginFailure('192.0.2.1',email);limiter.clearLoginFailures('192.0.2.1',email);
 }
 assert.equal(limiter.getStats().pairEntries,0);assert.equal(limiter.getStats().ipFailures,100);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','new@example.invalid'),900);
 setTime(windowMs-1);limited(()=>limiter.assertLoginAllowed('192.0.2.1','new@example.invalid'),1);
 setTime(windowMs);assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','new@example.invalid'));
 assert.equal(limiter.getStats().ipEntries,0);
});

test('pair saturation rejects new state without evicting locks or resetting existing failure counts',()=>{
 const {limiter}=fixture({maxPairs:3,maxIps:2});failures(limiter,'192.0.2.1','locked@example.invalid',5);
 limiter.recordLoginFailure('192.0.2.1','second@example.invalid');limiter.recordLoginFailure('192.0.2.1','third@example.invalid');
 const before=limiter.getStats();limited(()=>limiter.assertLoginAllowed('192.0.2.1','new@example.invalid'),900);
 limited(()=>limiter.recordLoginFailure('192.0.2.1','new@example.invalid'),900);assert.deepEqual(limiter.getStats(),before);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','locked@example.invalid'),900);
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','second@example.invalid'));
 failures(limiter,'192.0.2.1','second@example.invalid',4);limited(()=>limiter.assertLoginAllowed('192.0.2.1','second@example.invalid'),900);
 limiter.clearLoginFailures('192.0.2.1','second@example.invalid');limiter.recordLoginFailure('192.0.2.1','replacement@example.invalid');
 assert.equal(limiter.getStats().pairEntries,3);limited(()=>limiter.assertLoginAllowed('192.0.2.1','locked@example.invalid'),900);
});

test('IP saturation fails closed for new IPs, survives pair clear and releases capacity at TTL',()=>{
 const {limiter,setTime}=fixture({maxPairs:5,maxIps:2});failures(limiter,'192.0.2.1','locked@example.invalid',5);limiter.recordLoginFailure('192.0.2.2','other@example.invalid');
 const before=limiter.getStats();limited(()=>limiter.assertLoginAllowed('192.0.2.3','new@example.invalid'),900);
 limited(()=>limiter.recordLoginFailure('192.0.2.3','new@example.invalid'),900);assert.deepEqual(limiter.getStats(),before);
 limiter.clearLoginFailures('192.0.2.2','other@example.invalid');limited(()=>limiter.assertLoginAllowed('192.0.2.3','new@example.invalid'),900);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','locked@example.invalid'),900);
 setTime(windowMs);limiter.assertLoginAllowed('192.0.2.3','new@example.invalid');limiter.recordLoginFailure('192.0.2.3','new@example.invalid');
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().ipEntries,1);
});

test('TTL cleanup is incremental and bounded rather than scanning every retained entry per request',()=>{
 const {limiter,setTime}=fixture({maxPairs:12,maxIps:12,cleanupBatchSize:2});
 for(let i=0;i<12;i++)limiter.recordLoginFailure('192.0.2.'+(i+1),'user@example.invalid');
 assert.equal(limiter.getStats().pairEntries,12);setTime(windowMs);
 limiter.assertLoginAllowed('198.51.100.1','unknown@example.invalid');
 assert.equal(limiter.getStats().pairEntries,10);assert.equal(limiter.getStats().ipEntries,10);
 assert.equal(limiter.getStats().pairFailures,10);assert.equal(limiter.getStats().ipFailures,10);
 for(let i=0;i<5;i++)limiter.assertLoginAllowed('198.51.100.1','unknown@example.invalid');
 assert.equal(limiter.getStats().pairEntries,0);assert.equal(limiter.getStats().ipEntries,0);
});

test('refreshing a bucket preserves expiry ordering and cleanup never removes the refreshed state early',()=>{
 const {limiter,setTime}=fixture({maxPairs:2,maxIps:2,cleanupBatchSize:1});
 limiter.recordLoginFailure('192.0.2.1','refreshed@example.invalid');setTime(1);limiter.recordLoginFailure('192.0.2.2','older@example.invalid');
 setTime(100);limiter.recordLoginFailure('192.0.2.1','refreshed@example.invalid');
 setTime(windowMs+1);limiter.assertLoginAllowed('192.0.2.3','new@example.invalid');
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().ipEntries,1);
 limiter.recordLoginFailure('192.0.2.3','new@example.invalid');
 limited(()=>limiter.assertLoginAllowed('192.0.2.4','capacity@example.invalid'),1);
 setTime(windowMs+100);limiter.assertLoginAllowed('192.0.2.4','capacity@example.invalid');
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().ipEntries,1);
 assert.equal(limiter.getStats().pairFailures,1);assert.equal(limiter.getStats().ipFailures,1);
});

test('in-flight failure floods cannot grow timestamp arrays or extend an already active lock',()=>{
 const {limiter,setTime}=fixture({maxPairs:2,maxIps:2});
 failures(limiter,'192.0.2.1','user@example.invalid',5000);
 assert.equal(limiter.getStats().pairFailures,5);assert.equal(limiter.getStats().ipFailures,100);
 setTime(windowMs-1);
 for(let i=0;i<1500;i++)limiter.recordLoginFailure('192.0.2.1','new-'+i+'@example.invalid');
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().ipEntries,1);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'),1);
 setTime(windowMs);assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'));
 assert.equal(limiter.getStats().pairFailures,0);assert.equal(limiter.getStats().ipFailures,0);
});

test('oversized email variants use one bounded bucket and cannot allocate one retained key per payload',()=>{
 const {limiter}=fixture({maxPairs:2,maxIps:2});
 for(let i=0;i<5;i++)limiter.recordLoginFailure('192.0.2.1','x'.repeat(16*1024)+i+'@example.invalid');
 assert.equal(limiter.getStats().pairEntries,1);assert.equal(limiter.getStats().pairFailures,5);
 limited(()=>limiter.assertLoginAllowed('192.0.2.1','y'.repeat(16*1024)),900);
 assert.doesNotThrow(()=>limiter.assertLoginAllowed('192.0.2.1','normal@example.invalid'));
 assert.ok(!JSON.stringify(limiter.getStats()).includes('example.invalid'));
});

test('case, surrounding whitespace and missing IP normalization preserve pair identity',()=>{
 const {limiter}=fixture();failures(limiter,undefined,'  User@Example.Invalid  ',5);
 limited(()=>limiter.assertLoginAllowed(null,'user@example.invalid'),900);
 limiter.clearLoginFailures(null,' USER@example.invalid ');assert.doesNotThrow(()=>limiter.assertLoginAllowed(undefined,'user@example.invalid'));
 assert.equal(limiter.getStats().ipFailures,5);
});

test('backwards clocks do not reopen locks and invalid clock/options cannot create unbounded state',()=>{
 const {limiter,setTime}=fixture({maxPairs:2,maxIps:2});setTime(1000);failures(limiter,'192.0.2.1','user@example.invalid',5);
 setTime(0);limited(()=>limiter.assertLoginAllowed('192.0.2.1','user@example.invalid'),900);
 const before=limiter.getStats();assert.throws(()=>limiter.recordLoginFailure('192.0.2.2','new@example.invalid',Number.NaN),RangeError);assert.deepEqual(limiter.getStats(),before);
 for(const options of[{maxPairs:0},{maxPairs:10001},{maxIps:Infinity},{cleanupBatchSize:0},{cleanupBatchSize:129}])assert.throws(()=>createLoginRateLimiter(options),RangeError);
});
