const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),rawId=params.get('id');
// These endpoints convert IDs to Number. Reject noncanonical or unsafe values
// instead of rounding a BIGINT string to a different customer identity.
const id=params.getAll('id').length===1&&rawId?.length<=16&&/^[1-9][0-9]*$/.test(rawId)&&Number.isSafeInteger(Number(rawId))?rawId:null;
const invalidIdMessage='El identificador del cliente no es válido. Abra el estado de cuenta desde la ficha del cliente.';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number(v||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
let data,requestId,busy=false,poll;
async function api(action,body={}){if(id===null)throw Error(invalidIdMessage);const r=await fetch(`/api/entities/customers/${encodeURIComponent(id)}/statement/${action}`,{method:'POST',headers:{Authorization:`Bearer ${localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token')}`,'X-Device-Token':localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'','Content-Type':'application/json'},body:JSON.stringify({cutoff:$('cutoff').value,subsidiaryId:params.get('subsidiaryId'),...body})});const d=await r.json();if(!r.ok)throw Error(d?.error?.message||'No fue posible procesar el estado de cuenta.');return d;}
function message(text){$('message').textContent=text;}
async function load(){clearTimeout(poll);data=null;$('pdf').disabled=true;$('compose').disabled=true;data=await api('get');const s=data.statement;$('name').textContent=s.cliente_nombre;$('email').textContent=`Correo: ${s.email||'Sin correo registrado'}`;$('balance').textContent=`Saldo neto: ${money(s.saldo_total)} ${s.moneda}`;$('transport').textContent=data.transport.enabled?'Envío SMTP activado.':'Envío desactivado: pendiente de configurar el SMTP y el remitente. Puede descargar el PDF y consultar el historial.';$('pdf').disabled=data.access?.canDownload!==true;$('compose').disabled=data.access?.canSend!==true||!data.transport.enabled||Number(s.saldo_total)<=0;$('history').innerHTML=data.history.map(l=>`<tr><td>${esc(new Date(l.created_at).toLocaleString('es-CR'))}</td><td>${esc(l.fecha_corte)}</td><td>${esc(l.destinatario)}</td><td>${esc(l.estado)}</td><td>${esc(l.enviado_at?new Date(l.enviado_at).toLocaleString('es-CR'):l.ultimo_error||'')}</td></tr>`).join('')||'<tr><td colspan="5">No hay comunicaciones registradas.</td></tr>';if(data.transport.enabled&&data.history.some(l=>['PENDIENTE','ENVIANDO'].includes(l.estado)))poll=setTimeout(()=>load().catch(e=>message(e.message)),10000);}
if(id===null){
 message(invalidIdMessage);
 for(const control of['refresh','pdf','compose','cutoff','note','confirmSend'])$(control).disabled=true;
 $('sendForm').onsubmit=e=>{e.preventDefault();message(invalidIdMessage);};
}else{
const now=new Date(),localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Costa_Rica',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
$('cutoff').value=params.get('cutoff')||localDate;$('cutoff').max=localDate;
$('refresh').onclick=()=>load().catch(e=>message(e.message));
$('cutoff').onchange=()=>{data=null;$('compose').disabled=true;$('pdf').disabled=true;};
$('compose').onclick=()=>{if(data?.access?.canSend!==true)return;requestId=crypto.randomUUID();$('recipient').textContent=data.statement.email||'Sin correo: actualice el perfil del cliente.';$('sendSummary').textContent=`Corte ${data.statement.fecha_corte} · ${money(data.statement.saldo_total)} ${data.statement.moneda}. Se adjuntará el PDF completo en moneda local.`;$('sendError').textContent='';$('note').value='';$('confirmation').showModal();};
$('cancel').onclick=()=>{if(!busy)$('confirmation').close();};
$('confirmation').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('sendForm').onsubmit=async e=>{e.preventDefault();if(busy||data?.access?.canSend!==true)return;busy=true;$('confirmSend').disabled=true;try{const result=await api('send',{note:$('note').value,requestId});$('confirmation').close();message(result.estado==='ERROR_SIN_CORREO'?'No se envió el correo: el cliente no tiene una dirección válida. Actualice su perfil.':'Envío registrado. El PDF se generará y enviará en segundo plano.');await load();}catch(err){$('sendError').textContent=err.message;}finally{busy=false;$('confirmSend').disabled=false;}};
$('pdf').onclick=async()=>{if(data?.access?.canDownload!==true)return;$('pdf').disabled=true;try{const d=await api('pdf'),bytes=Uint8Array.from(atob(d.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),a=document.createElement('a');a.href=url;a.download=d.fileName;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){message(e.message);}finally{$('pdf').disabled=data?.access?.canDownload!==true;}};
try{await load();if(params.get('compose')==='1'&&!$('compose').disabled)$('compose').click();}catch(e){message(e.message);}
addEventListener('pagehide',()=>clearTimeout(poll));
}
