// Public official data only. JWT verification is enforced by the platform.
// No database access and no arbitrary outbound URLs.
Deno.serve(async(req:Request)=>{
 if(req.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
 try{
 const p=await req.json(),country=p.country,date=p.date;
 if(!['GT','AR','PE'].includes(country)||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)return Response.json({error:'Invalid country/date'},{status:400});
 const [y,m,d]=date.split('-');let url='',init:RequestInit={headers:{Accept:'*/*','User-Agent':'Gentia ERP/1.0'},signal:AbortSignal.timeout(20000),redirect:'error'};
 if(country==='AR')url='https://www.bna.com.ar/Cotizador/HistoricoPrincipales?id=billetes&fecha='+encodeURIComponent(d+'/'+m+'/'+y)+'&idMoneda=22';
 if(country==='GT'){url='https://www.banguat.gob.gt/variables/ws/TipoCambio.asmx';init={...init,method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'"http://www.banguat.gob.gt/variables/ws/TipoCambioRango"'},body:'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><TipoCambioRango xmlns="http://www.banguat.gob.gt/variables/ws/"><fechainit>'+d+'/'+m+'/'+y+'</fechainit><fechafin>'+d+'/'+m+'/'+y+'</fechafin></TipoCambioRango></soap:Body></soap:Envelope>'};}
 if(country==='PE'){const start=new Date(date+'T12:00:00Z');start.setUTCDate(start.getUTCDate()-7);url='https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04639PD-PD04640PD/json/'+start.toISOString().slice(0,10)+'/'+date+'/esp';}
 const response=await fetch(url,init);const body=await response.text();if(body.length>1000000)throw Error('Oversized response');
 return Response.json({country,date,upstreamStatus:response.status,body},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Official source unavailable'},{status:502});}
});
