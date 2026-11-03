import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {X509Certificate} from 'node:crypto';
import * as tls from 'node:tls';
import {test} from 'node:test';

const {bcnTlsOptions}=await import('../dist/modules/configuration-catalogs/services/nicaragua-bcn-tls.js');
const {consultarTasaBcn,obtenerTipoDeCambioNI}=await import('../dist/modules/configuration-catalogs/services/nicaragua-exchange-rate.service.js');
const soap=rate=>`<soap:Envelope><soap:Body><RecuperaTC_DiaResponse><RecuperaTC_DiaResult>${rate}</RecuperaTC_DiaResult></RecuperaTC_DiaResponse></soap:Body></soap:Envelope>`;

function transport(reply=({respond})=>respond(200,soap('36.6243'))){
  const calls=[];
  const request=(url,options,onResponse)=>{
    const req=new EventEmitter(),call={url,options,request:req};
    calls.push(call);
    req.setTimeout=(ms,callback)=>{call.idleTimeout=ms;call.onIdleTimeout=callback;return req;};
    req.destroy=error=>{call.destroyed=true;queueMicrotask(()=>req.emit('error',error));return req;};
    req.end=body=>{
      call.body=body;
      queueMicrotask(()=>reply({
        ...call,
        respond:(statusCode,xml,afterHeaders)=>{
          const response=new EventEmitter();
          response.statusCode=statusCode;response.complete=true;
          response.setEncoding=()=>response;response.resume=()=>response;
          onResponse(response);
          if(afterHeaders){afterHeaders(response);return;}
          response.emit('data',xml);response.emit('end');
        }
      }));
      return req;
    };
    return req;
  };
  return{request,calls};
}

test('completa la cadena del BCN con el intermediario auténtico y conserva las autoridades predeterminadas',()=>{
  const before=tls.getCACertificates?.('default')??[...tls.rootCertificates];
  const options=bcnTlsOptions();
  assert.equal(options.minVersion,'TLSv1.2');
  assert.equal(options.rejectUnauthorized,true);
  assert.notEqual(options.allowPartialTrustChain,true);
  assert.equal(options.checkServerIdentity,undefined);
  assert.equal(options.ciphers,undefined);
  assert.deepEqual(options.ca.slice(0,before.length),before);
  assert.equal(options.ca.length,before.length+1);
  const intermediate=new X509Certificate(options.ca.at(-1));
  assert.equal(intermediate.fingerprint256.replaceAll(':',''),'C8025F9FC65FDFC95B3CA8CC7867B9A587B5277973957917463FC813D0B625A9');
  assert.equal(intermediate.ca,true);
  const root=tls.rootCertificates.map(pem=>new X509Certificate(pem)).find(cert=>cert.subject===intermediate.issuer&&intermediate.verify(cert.publicKey));
  assert.ok(root,'El intermediario debe estar firmado por una raíz pública incluida en Node.');
  assert.deepEqual(tls.getCACertificates?.('default')??[...tls.rootCertificates],before);
});

test('consulta exclusivamente el SOAP oficial con TLS verificado y transmite la fecha solicitada',async()=>{
  const fake=transport();
  assert.equal(await consultarTasaBcn('2026-11-03',fake),36.6243);
  const call=fake.calls[0];
  assert.equal(String(call.url),'https://servicios.bcn.gob.ni/Tc_Servicio/ServicioTC.asmx');
  assert.equal(call.options.method,'POST');
  assert.equal(call.options.rejectUnauthorized,true);
  assert.equal(call.options.minVersion,'TLSv1.2');
  assert.match(call.body,/<Ano>2026<\/Ano><Mes>11<\/Mes><Dia>3<\/Dia>/);
  assert.equal(call.options.headers['Content-Length'],Buffer.byteLength(call.body));
  assert.equal(call.options.headers.SOAPAction,'"http://servicios.bcn.gob.ni/RecuperaTC_Dia"');
});

test('mantiene la fecha efectiva y calcula USD/NIO y su recíproco',async()=>{
  const direct=await obtenerTipoDeCambioNI(' usd ',' nio ','2026-11-03',transport());
  assert.equal(direct.tipoCambio,36.6243);
  assert.equal(direct.fechaEfectiva,'2026-11-03');
  assert.equal(direct.fechaFuente,'2026-11-03');
  const inverse=await obtenerTipoDeCambioNI('NIO','USD','2026-11-03',transport());
  assert.equal(inverse.tipoCambio,1/36.6243);
  assert.equal(inverse.tasaVenta,36.6243);
});

test('busca una tasa previa válida sin modificar la fecha efectiva',async()=>{
  let count=0;
  const fake=transport(({respond})=>respond(200,soap(++count<3?'0':'36.6243')));
  const result=await obtenerTipoDeCambioNI('USD','NIO','2026-11-03',fake);
  assert.equal(result.fechaEfectiva,'2026-11-03');
  assert.equal(result.fechaFuente,'2026-11-01');
  assert.equal(fake.calls.length,3);
});

test('agota solo ocho fechas cuando no existe una tasa oficial válida',async()=>{
  const fake=transport(({respond})=>respond(200,soap('0')));
  await assert.rejects(obtenerTipoDeCambioNI('USD','NIO','2026-11-03',fake),/7 días anteriores/);
  assert.equal(fake.calls.length,8);
  assert.match(fake.calls.at(-1).body,/<Ano>2026<\/Ano><Mes>10<\/Mes><Dia>27<\/Dia>/);
});

test('rechaza HTTP fallido sin aceptar la tasa incluida en su cuerpo',async()=>{
  const fake=transport(({respond})=>respond(503,soap('36.6243')));
  await assert.rejects(obtenerTipoDeCambioNI('USD','NIO','2026-11-03',fake),/503/);
  assert.equal(fake.calls.length,1);
});

test('un error de certificado detiene la consulta sin degradar TLS ni buscar otra fecha',async()=>{
  const error=Object.assign(new Error('unable to verify the first certificate'),{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'});
  const fake=transport(({request})=>request.emit('error',error));
  await assert.rejects(obtenerTipoDeCambioNI('USD','NIO','2026-11-03',fake),Error);
  assert.equal(fake.calls.length,1);
  assert.equal(fake.calls[0].options.rejectUnauthorized,true);
  assert.notEqual(fake.calls[0].options.allowPartialTrustChain,true);
});

test('el límite absoluto cancela una conexión que nunca responde',async()=>{
  const fake=transport(()=>{});
  await assert.rejects(consultarTasaBcn('2026-11-03',{...fake,timeoutMs:10}),/tiempo de espera/);
  assert.equal(fake.calls[0].destroyed,true);
});

test('rechaza una respuesta abortada antes de interpretar su tasa parcial',async()=>{
  const fake=transport(({respond})=>respond(200,'',response=>{
    response.complete=false;
    response.emit('data',soap('36.6243'));
    response.emit('aborted');
  }));
  await assert.rejects(consultarTasaBcn('2026-11-03',fake),/interrump|abort|complet/i);
});

test('propaga el error del flujo de respuesta sin dejar la consulta pendiente',async()=>{
  const fake=transport(({respond})=>respond(200,'',response=>response.emit('error',new Error('fallo del flujo de respuesta'))));
  await assert.rejects(consultarTasaBcn('2026-11-03',fake),Error);
});
