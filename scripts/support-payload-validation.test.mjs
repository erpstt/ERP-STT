import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Buffer} from 'node:buffer';
import {spawnSync} from 'node:child_process';
import {
 validateNewJournalSupport as validate,
 validateNewJournalSupports as validateCollection,
 SupportPayloadValidationError,
 SUPPORT_FILE_MAX_BYTES,
 SUPPORT_COLLECTION_MAX_BYTES,
 SUPPORT_COLLECTION_MAX_COUNT
} from '../dist/core/security/support-payload-validation.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

function file(bytes=Buffer.from('Synthetic receipt'),type='text/plain',name='receipt.txt'){
 return{support_type:'Archivo',display_name:'Receipt / synthetic',file_name:name,mime_type:type,file_size:bytes.length,file_data:`data:${type};base64,${bytes.toString('base64')}`};
}
const link=(url='https://example.invalid/receipt')=>({support_type:'Enlace',display_name:'Receipt / synthetic',support_url:url});
function denied(work,status=400,code){
 assert.throws(work,error=>error instanceof SupportPayloadValidationError&&error.status===status&&(!code||error.code===code));
}
function withoutDecode(work){
 const original=Buffer.from;
 Buffer.from=function(...args){if(args[1]==='base64')assert.fail('Invalid input reached base64 allocation.');return Reflect.apply(original,this,args);};
 try{work();}finally{Buffer.from=original;}
}
const signatures=[
 ['application/pdf','receipt.pdf',Buffer.from('%PDF-1.7\nSynthetic')],
 ['image/png','receipt.png',Buffer.from([137,80,78,71,13,10,26,10,0])],
 ['image/jpeg','receipt.jpeg',Buffer.from([255,216,255,224])],
 ['image/gif','receipt.gif',Buffer.from('GIF89a\0')],
 ['image/webp','receipt.webp',Buffer.from('RIFF0000WEBPsynthetic')],
 ['image/bmp','receipt.bmp',Buffer.from('BMsynthetic')]
];

test('new file returns a canonical DTO without mutating or retaining caller fields',()=>{
 const input=Object.freeze({...file(),file_size:'17',journal_id:99,_new:true,extra:{ignored:true}});
 assert.equal(input.file_size,Buffer.from('Synthetic receipt').length.toString());
 assert.deepEqual(validate(input),file());
 assert.equal(input.journal_id,99);
 assert.ok(!Object.hasOwn(validate(input),'journal_id'));
});

test('PDF and every supported raster family require their known extension and signature',()=>{
 for(const[type,name,bytes]of signatures)assert.equal(validate(file(bytes,type,name)).mime_type,type);
 assert.equal(validate(file(signatures[2][2],'image/jpeg','RECEIPT.JPG')).file_name,'RECEIPT.JPG');
 assert.equal(validate(file(Buffer.from('GIF87a'),'image/gif','receipt.gif')).file_size,6);
});

test('compatible Office/vendor, ZIP, XML, text and opaque downloads remain supported',()=>{
 const formats=[
  ['application/msword','receipt.doc'],['application/zip','receipt.zip'],
  ['application/xml','receipt.xml'],['text/xml','receipt.xml'],['text/csv','receipt.csv'],
  ['text/plain','receipt.txt'],['application/octet-stream','receipt.unknown'],
  ['application/vnd.ms-excel','receipt.xls'],['application/vnd.ms-powerpoint','receipt.ppt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document','receipt.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','receipt.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation','receipt.pptx'],
  ['application/vnd.synthetic.future+zip','receipt.future']
 ];
 // These download formats are intentionally not claimed to be parsed or scanned.
 for(const[type,name]of formats)assert.equal(validate(file(Buffer.from('opaque synthetic bytes'),type,name)).mime_type,type);
});

test('MIME case is normalized and octet-stream defaults only when both MIME fields are empty',()=>{
 const input=file(Buffer.from('opaque'),'','receipt.bin');
 assert.equal(validate({...input,mime_type:null}).mime_type,'application/octet-stream');
 assert.equal(validate({...input,mime_type:undefined}).file_data,'data:application/octet-stream;base64,b3BhcXVl');
 const upper=file(Buffer.from('synthetic'),'TEXT/PLAIN');
 assert.equal(validate(upper).file_data,'data:text/plain;base64,c3ludGhldGlj');
 denied(()=>validate({...input,mime_type:'application/octet-stream'}));
 denied(()=>validate({...file(Buffer.from('x'),'application/octet-stream'),mime_type:''}));
});

test('non-object JSON, array elements and unknown support types are rejected',()=>{
 for(const value of[undefined,null,true,false,0,1,'',[],['Archivo'],{},new Date(),new Map()])denied(()=>validate(value));
 for(const support_type of[null,1,true,{},[],'archivo','Link','Archivo '])denied(()=>validate({...file(),support_type}));
 assert.equal(validate(Object.assign(Object.create(null),link())).support_type,'Enlace');
});

test('metadata stays primitive and never invokes caller conversion hooks or accessors',()=>{
 let conversions=0;
 const bad={valueOf(){conversions++;throw Error('Do not call');},toString(){conversions++;throw Error('Do not call');}};
 for(const field of['display_name','file_name','mime_type','file_size','file_data']){
  for(const value of[bad,{},[],true])denied(()=>validate({...file(),[field]:value}));
 }
 const accessor={...file(),get file_size(){conversions++;throw Error('Do not read');}};
 denied(()=>validate(accessor));
 assert.equal(conversions,0);
});

test('file_size accepts only a positive safe integer or its canonical decimal string',()=>{
 assert.equal(validate({...file(),file_size:'17'}).file_size,17);
 for(const value of[0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'','0','00','017','+17','-17','17.0','1.7e1',' 17','17 ','0x11',null,undefined]){
  denied(()=>validate({...file(),file_size:value}));
 }
 for(const suffix of['\n','\r','\r\n','\u2028','\u2029'])denied(()=>validate({...file(),file_size:'17'+suffix}));
});

test('labels may contain slash while filenames cannot be paths or contain controls',()=>{
 assert.equal(validate({...file(),display_name:' Receipt / Q4 '}).display_name,'Receipt / Q4');
 for(const file_name of['',' ','..','.', '../receipt.txt','folder/receipt.txt','folder\\receipt.txt','receipt\u0000.txt','receipt\n.txt','x'.repeat(256)]){
  denied(()=>validate({...file(),file_name}));
 }
 for(const display_name of['',' ','label\u0000','label\n','x'.repeat(251),42])denied(()=>validate({...file(),display_name}));
 for(const mime_type of['\n','text/plain\n','\u007f','\u0085'])denied(()=>validate({...file(),mime_type}));
});

test('empty files, byte-length mismatch and forged declared lengths are denied',()=>{
 denied(()=>validate(file(Buffer.alloc(0))));
 for(const size of[1,16,18,100])denied(()=>validate({...file(),file_size:size}));
 const input=file();
 withoutDecode(()=>{
  denied(()=>validate({...input,file_size:1}));
  denied(()=>validate({...input,file_size:SUPPORT_FILE_MAX_BYTES+1}),413);
  denied(()=>validate({...input,file_size:'999999999999999999999999'}),413);
 });
});

test('exactly five MiB is accepted and the actual-byte limit cannot be bypassed by metadata',()=>{
 const exact=file(Buffer.alloc(SUPPORT_FILE_MAX_BYTES,1),'application/octet-stream','receipt.bin');
 assert.equal(validate(exact).file_size,SUPPORT_FILE_MAX_BYTES);
 const over=file(Buffer.alloc(SUPPORT_FILE_MAX_BYTES+1,1),'application/octet-stream','receipt.bin');
 withoutDecode(()=>denied(()=>validate({...over,file_size:SUPPORT_FILE_MAX_BYTES}),413));
});

test('oversized encoded strings and headers are refused before any base64 allocation',()=>{
 const encoded='A'.repeat(Math.ceil(SUPPORT_FILE_MAX_BYTES/3)*4);
 withoutDecode(()=>{
  denied(()=>validate({...file(),file_data:'data:text/plain;base64,'+encoded+'AAAA'}),413);
  // Same encoded length as the maximum valid file, but one more decoded byte.
  denied(()=>validate({...file(),file_data:'data:text/plain;base64,'+encoded}),413);
  denied(()=>validate({...file(),file_data:'data:'+('a'.repeat(200))+';base64,QQ=='}));
 });
});

test('base64 must use its complete canonical standard alphabet, padding and unused bits',()=>{
 const invalid=['','A','AA','AAA','AAAAA','AA=','AA===','====','AA=A','____','-w==','Q Q=','QQ==\n','QQ==\r\n','QQ==\u2028','AR==','AQJ='];
 for(const encoded of invalid)denied(()=>validate({...file(),file_size:1,file_data:'data:text/plain;base64,'+encoded}));
 for(const bytes of[Buffer.from([0]),Buffer.from([0,255]),Buffer.from([0,255,127])])assert.equal(validate(file(bytes)).file_size,bytes.length);
});

test('only the exact Data URL grammar is accepted, with no raw base64, parameters or trailing header newline',()=>{
 for(const file_data of['QQ==','https://example.invalid/file','blob:https://example.invalid/x','data:text/plain,QQ==','data:text/plain;charset=utf-8;base64,QQ==','data:text/plain;base64,QQ==,','data:text/plain;base64url,QQ==']){
  denied(()=>validate({...file(),file_size:1,file_data}));
 }
 for(const suffix of['\n','\r','\r\n','\u2028','\u2029']){
  denied(()=>validate({...file(),file_size:1,file_data:'data:text/plain;base64'+suffix+',QQ=='}));
 }
});

test('metadata MIME must agree with Data URL MIME and executable MIME families are rejected',()=>{
 denied(()=>validate({...file(),mime_type:'application/pdf'}));
 for(const type of['text/html','image/svg+xml','application/javascript','text/javascript','application/xhtml+xml','audio/mpeg','image/jpg']){
  denied(()=>validate(file(Buffer.from('synthetic'),type,'receipt.bin')));
 }
 withoutDecode(()=>denied(()=>validate({...file(),mime_type:'application/zip'})));
});

test('trusted-family signature or extension mismatch is refused, including high-bit signature aliases',()=>{
 for(const[type,name,bytes]of signatures){
  denied(()=>validate(file(Buffer.from('not this format'),type,name)));
  denied(()=>validate(file(bytes,type,'receipt.txt')));
  denied(()=>validate(file(bytes,type,name.slice(name.lastIndexOf('.')+1))));
  denied(()=>validate(file(bytes,type,name.slice(name.lastIndexOf('.')))));
  denied(()=>validate(file(bytes.subarray(0,1),type,name)));
  const altered=Buffer.from(bytes);altered[0]^=128;
  denied(()=>validate(file(altered,type,name)));
 }
 denied(()=>validate(file(signatures[0][2],'application/pdf','receipt.pdf.txt')));
});

test('new links use normalized HTTPS and preserve a slash in the visible label',()=>{
 assert.deepEqual(validate(link('HTTPS://EXAMPLE.INVALID:443/receipt?kind=synthetic#page')),{...link(),support_url:'https://example.invalid/receipt?kind=synthetic#page'});
 assert.equal(validate({...link(),file_name:null,mime_type:'',file_size:null,file_data:''}).support_type,'Enlace');
});

test('new links reject credentials, ambiguous authority, unsafe schemes, controls and backslashes',()=>{
 const urls=[
  '', 'http://example.invalid/receipt','//example.invalid/receipt','javascript:alert(1)','data:text/plain;base64,QQ==',
  'https://user@example.invalid/','https://user:password@example.invalid/','https://@example.invalid/',
  'https://example.invalid\\@other.invalid/','https:\\example.invalid/','https:///example.invalid/',
  ' https://example.invalid/','https://example.invalid/a b','https://example.invalid/\nnext',
  'https://example.invalid/\rnext','https://example.invalid/\u0000','https://example.invalid/\u007f',
  'https://example.invalid/\u0085','https://example.invalid/\u2028','https://example.invalid/\u2029',
  'https://','https://example.invalid:99999/','https://example.invalid/'+('x'.repeat(2048))
 ];
 for(const url of urls)denied(()=>validate(link(url)));
 for(const support_url of[null,1,true,{},[]])denied(()=>validate({...link(),support_url}));
});

test('link/file mixtures are refused rather than silently carrying both content kinds',()=>{
 for(const[field,value]of[['file_name','receipt.txt'],['mime_type','text/plain'],['file_size',0],['file_data','QQ=='],['file_size',{}]]){
  denied(()=>validate({...link(),[field]:value}));
 }
 for(const support_url of['https://example.invalid/',0,{},[]])denied(()=>validate({...file(),support_url}));
});

test('new-only helpers never accept a support_id as a shortcut around validation',()=>{
 for(const support_id of[1,'1',null,undefined,0,-1,{},[]]){
  denied(()=>validate({...file(),support_id}));
  denied(()=>validate({...link(),support_id}));
  denied(()=>validateCollection([{support_id}]));
 }
});

test('collections allow empty and twenty new items, rejecting malformed or excessive items before decoding',()=>{
 assert.deepEqual(validateCollection([]),[]);
 assert.equal(validateCollection(Array.from({length:SUPPORT_COLLECTION_MAX_COUNT},()=>link())).length,20);
 const input=file();
 withoutDecode(()=>denied(()=>validateCollection(Array.from({length:21},()=>input)),413));
 for(const input of[null,undefined,{},true,'',1,[null],[[]],new Array(1)])denied(()=>validateCollection(input));
});

test('collection budget accepts exactly six MiB and rejects overflow before allocating the overflowing file',()=>{
 const part=file(Buffer.alloc(SUPPORT_COLLECTION_MAX_BYTES/3,1),'application/octet-stream','part.bin');
 assert.equal(validateCollection([part,part,part]).reduce((total,item)=>total+item.file_size,0),SUPPORT_COLLECTION_MAX_BYTES);
 const first=file(Buffer.alloc(SUPPORT_FILE_MAX_BYTES,1),'application/octet-stream','first.bin');
 const second=file(Buffer.alloc(SUPPORT_COLLECTION_MAX_BYTES-SUPPORT_FILE_MAX_BYTES+1,1),'application/octet-stream','second.bin');
 const original=Buffer.from;let decodes=0;
 Buffer.from=function(...args){if(args[1]==='base64')decodes++;return Reflect.apply(original,this,args);};
 try{denied(()=>validateCollection([first,second]),413);assert.equal(decodes,1);}finally{Buffer.from=original;}
});

test('validation errors expose only fixed codes and messages, never input content',()=>{
 const canary='SYNTHETIC_SECRET_SQL_TOKEN_112';
 for(const input of[link('https://'+canary+'@example.invalid/'),{...file(),mime_type:canary},{...file(),file_size:canary},{...file(),file_data:canary}]){
  assert.throws(()=>validate(input),error=>{
   assert.ok(error instanceof SupportPayloadValidationError);
   assert.ok(!String(error.stack).includes(canary));
   assert.ok(!JSON.stringify(error).includes(canary));
   assert.ok(!String(error).includes(canary));
   return true;
  });
 }
});

test('pure helper operates with credential canaries while live IO and environment-file access are blocked',()=>{
 const env={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{SUPABASE_URL:'https://synthetic-112.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic_112_service_key',PGHOST:'synthetic-112.invalid',PGPASSWORD:'synthetic_112_password',SMTP_PASSWORD:'synthetic_112_mail'});
 const code="const {validateNewJournalSupport,validateNewJournalSupports}=await import(process.argv[1]);validateNewJournalSupport({support_type:'Enlace',display_name:'Synthetic',support_url:'https://example.invalid/'});validateNewJournalSupports([{support_type:'Archivo',display_name:'Synthetic',file_name:'receipt.txt',mime_type:'text/plain',file_size:1,file_data:'data:text/plain;base64,QQ=='}]);";
 const result=spawnSync(process.execPath,['--import',new URL('./fixtures/operator-no-live-io.mjs',import.meta.url).href,'--input-type=module','-e',code,new URL('../dist/core/security/support-payload-validation.js',import.meta.url).href],{env,encoding:'utf8',timeout:10000});
 if(result.error)throw result.error;
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});
