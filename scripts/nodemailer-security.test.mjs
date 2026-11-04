import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';

// Published reproductions from the maintainers. Stream transport composes the
// same recipient envelope without connecting to SMTP or using real settings.
const recipientCases=[
  {
    advisory:'GHSA-8c8m-p3m8-cjg8',
    source:'https://github.com/nodemailer/nodemailer/security/advisories/GHSA-8c8m-p3m8-cjg8',
    input:'Victim (x(y) <evil@evil.com>) <v@victim.com>',
    expected:'v@victim.com'
  },
  {
    advisory:'GHSA-m943-m63m-w62w comment',
    source:'https://github.com/nodemailer/nodemailer/security/advisories/GHSA-m943-m63m-w62w',
    input:'G: (a; <evil@evil.com>) <v@victim.com>;',
    expected:'v@victim.com'
  },
  {
    advisory:'GHSA-m943-m63m-w62w quoted display name',
    source:'https://github.com/nodemailer/nodemailer/security/advisories/GHSA-m943-m63m-w62w',
    input:'G: "a;" "<evil@evil.com>" <v@victim.com>;',
    expected:'v@victim.com'
  },
  {
    advisory:'GHSA-85x2-q946-cp5h',
    source:'https://github.com/nodemailer/nodemailer/security/advisories/GHSA-85x2-q946-cp5h',
    input:'<"a@evil.com>"@good.com>',
    expected:'"a@evil.com>"@good.com',
    // The MIME composer strips angle brackets from a mailbox's local part.
    // The fixed parser must retain good.com, and header and envelope must agree.
    envelopeExpected:'"a@evil.com "@good.com'
  }
];
const sender='sender@example.invalid',recipient='recipient@example.invalid';
const base={from:sender,to:recipient,subject:'Synthetic notification',text:'Synthetic content only.'};
function transport(t,options={}){
  const client=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows',...options});
  t.after(()=>client.close());
  return client;
}
function headerValues(message,name){
  const headers=message.toString('utf8').split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g,' ');
  return headers.split('\r\n').filter(line=>line.toLowerCase().startsWith(name.toLowerCase()+':')).map(line=>line.slice(line.indexOf(':')+1).trim());
}

test('security fixtures accept no destinations, credentials or execution options',()=>{
  assert.deepEqual(process.argv.slice(2),[]);
});
for(const {advisory,source,input,expected,envelopeExpected=expected}of recipientCases)test(advisory+': parser and composed envelope keep the approved recipient domain',async t=>{
  assert.deepEqual(addressparser(input,{flatten:true}).map(item=>item.address),[expected],source);
  const client=transport(t,{disableFileAccess:true,disableUrlAccess:true});
  const result=await client.sendMail({...base,to:input,disableFileAccess:true,disableUrlAccess:true});
  assert.deepEqual(result.envelope,{from:sender,to:[envelopeExpected]},source);
  assert.ok(Buffer.isBuffer(result.message));
  const to=headerValues(result.message,'To');assert.equal(to.length,1);
  assert.deepEqual(addressparser(to[0],{flatten:true}).map(item=>item.address),[envelopeExpected]);
});

test('in-memory PDF and CSV attachments retain their bytes and standard MIME headers',async t=>{
  const client=transport(t,{disableFileAccess:true,disableUrlAccess:true});
  const pdf=Buffer.from('%PDF-1.4\nSynthetic fixture\n%%EOF\n'),csv=Buffer.from('codigo,monto\r\n00123,-123.45\r\n');
  const result=await client.sendMail({...base,from:{name:'GENTIA ERP',address:sender},
    messageId:'<synthetic-m06@example.invalid>',date:new Date('2026-11-04T00:00:00Z'),
    html:'<p>Synthetic notification with two attachments.</p>',
    disableFileAccess:true,disableUrlAccess:true,
    attachments:[{filename:'factura.pdf',content:pdf,contentType:'application/pdf'},
      {filename:'reporte.csv',content:csv,contentType:'text/csv'}]});
  assert.deepEqual(result.envelope,{from:sender,to:[recipient]});
  assert.equal(result.messageId,'<synthetic-m06@example.invalid>');
  assert.deepEqual(headerValues(result.message,'From'),['GENTIA ERP <'+sender+'>']);
  assert.deepEqual(headerValues(result.message,'To'),[recipient]);
  assert.deepEqual(headerValues(result.message,'Subject'),[base.subject]);
  assert.deepEqual(headerValues(result.message,'MIME-Version'),['1.0']);
  assert.deepEqual(headerValues(result.message,'Message-ID'),['<synthetic-m06@example.invalid>']);
  const mime=result.message.toString('utf8');
  assert.match(mime,/Content-Type: application\/pdf\b/i);assert.match(mime,/Content-Type: text\/csv\b/i);
  assert.match(mime,/Content-Disposition: attachment; filename="?factura\.pdf"?/i);
  assert.match(mime,/Content-Disposition: attachment; filename="?reporte\.csv"?/i);
  assert.ok(mime.includes(pdf.toString('base64')));assert.ok(mime.includes(csv.toString('base64')));
});
test('CRLF in subject and custom header values cannot introduce recipients or new headers',async t=>{
  const client=transport(t,{disableFileAccess:true,disableUrlAccess:true});
  const result=await client.sendMail({...base,subject:'Synthetic\r\nBcc: injected@example.invalid',
    headers:{'X-Gentia-Fixture':'synthetic\r\nX-Injected: forbidden'}});
  assert.deepEqual(result.envelope,{from:sender,to:[recipient]});
  assert.equal(headerValues(result.message,'Subject').length,1);
  assert.equal(headerValues(result.message,'X-Gentia-Fixture').length,1);
  assert.deepEqual(headerValues(result.message,'Bcc'),[]);assert.deepEqual(headerValues(result.message,'X-Injected'),[]);
});

for(const scope of ['message','transport'])test(scope+' access policy blocks file and URL content before any IO, including raw messages',async t=>{
  let ioAttempts=0;
  const denied=()=>{ioAttempts++;throw Error('Synthetic forbidden IO attempted');};
  for(const method of ['readFile','readFileSync','open','openSync','createReadStream'])t.mock.method(fs,method,denied);
  for(const owner of [http,https])for(const method of ['request','get'])t.mock.method(owner,method,denied);
  t.mock.method(net.Socket.prototype,'connect',denied);t.mock.method(tls,'connect',denied);t.mock.method(globalThis,'fetch',denied);
  const policy={disableFileAccess:true,disableUrlAccess:true};
  const client=transport(t,scope==='transport'?policy:{});
  const messagePolicy=scope==='message'?policy:{disableFileAccess:false,disableUrlAccess:false};
  for(const [content,error]of [
    [{attachments:[{filename:'synthetic.pdf',path:'synthetic-forbidden-fixture.pdf'}]},/File access rejected/],
    [{attachments:[{filename:'synthetic.pdf',href:'https://synthetic.invalid/forbidden.pdf'}]},/Url access rejected/],
    [{html:{path:'synthetic-forbidden-fixture.html'}},/File access rejected/],
    [{raw:{path:'synthetic-forbidden-fixture.eml'}},/File access rejected/],
    [{raw:{href:'https://synthetic.invalid/forbidden.eml'}},/Url access rejected/]
  ])await assert.rejects(client.sendMail({...base,...messagePolicy,...content}),error);
  assert.equal(ioAttempts,0,'Access policies must reject before touching files or the network');
});
