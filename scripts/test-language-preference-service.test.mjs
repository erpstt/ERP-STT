import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch=globalThis.fetch;
const originalUrl=process.env.SUPABASE_URL;
const originalKey=process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_URL='https://language-preference.example.test';
process.env.SUPABASE_ANON_KEY='anon-test-key';

const {getLanguagePreference,setLanguagePreference}=await import('../dist/modules/auth/services/language-preference.service.js');

test.after(()=>{
  globalThis.fetch=originalFetch;
  if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;
  if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;
});

const preference={
  languageId:3,
  code:'1',
  isoCode:'SPA',
  locale:'es',
  name:'Español',
  languages:[
    {languageId:3,code:'1',isoCode:'SPA',locale:'es',name:'Español'},
    {languageId:4,code:'2',isoCode:'ENG',locale:'en',name:'Inglés'},
    {languageId:5,code:'3',isoCode:'POR',locale:'pt',name:'Portugués'},
  ],
};

test('consulta la preferencia y las opciones activas del catálogo Core',async()=>{
  let requested;
  globalThis.fetch=async(input,init)=>{
    requested={url:new URL(String(input)),init};
    return Response.json(preference);
  };
  assert.deepEqual(await getLanguagePreference('Bearer test-token'),preference);
  assert.equal(requested.url.pathname,'/rest/v1/rpc/user_language_preference');
  assert.equal(requested.init.method,'POST');
  assert.equal(new Headers(requested.init.headers).get('Authorization'),'Bearer test-token');
});

test('normaliza y guarda solamente Español, Inglés o Portugués',async()=>{
  const requests=[];
  globalThis.fetch=async(input,init)=>{
    requests.push({url:new URL(String(input)),init});
    return Response.json({...preference,locale:'pt',languageId:5,name:'Portugués'});
  };
  const result=await setLanguagePreference('Bearer test-token','pt-BR');
  assert.equal(result.locale,'pt');
  assert.equal(requests[0].url.pathname,'/rest/v1/rpc/set_user_language_preference');
  assert.deepEqual(JSON.parse(requests[0].init.body),{p_locale:'pt'});
  assert.throws(()=>setLanguagePreference('Bearer test-token','fr'),/Español, Inglés o Portugués/);
  assert.equal(requests.length,1,'Un idioma no compatible debe rechazarse antes de llamar a Supabase.');
});

