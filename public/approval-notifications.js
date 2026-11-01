(()=>{
  if(window!==window.top)return;

  const POLL_INTERVAL_MS=60_000;
  const AUTH_RETRY_MS=5_000;
  const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Costa_Rica',year:'numeric',month:'2-digit',day:'2-digit'});
  const openWorkspace=(url,module,section)=>window.dispatchEvent(new CustomEvent('nexo:open-workspace',{detail:{url,module,section}}));
  let timer=null;
  let controller=null;
  let pollSequence=0;
  let approvals=null;
  let taxes=null;
  let style=null;
  let lastScope='';

  function credentials(){
    return{
      token:localStorage.getItem('nexo_token')||sessionStorage.getItem('nexo_token')||'',
      device:localStorage.getItem('nexo_device_token')||sessionStorage.getItem('nexo_device_token')||'',
      company:localStorage.getItem('nexo_company')||sessionStorage.getItem('nexo_company')||'',
      role:localStorage.getItem('nexo_role')||sessionStorage.getItem('nexo_role')||''
    };
  }

  const contextKey=()=>JSON.stringify(credentials());
  function resetContext(){pollSequence+=1;controller?.abort();controller=null;unmount();schedule(0);}

  function mount(){
    if(approvals)return;
    approvals=document.createElement('button');
    approvals.className='nexo-alert-button nexo-approval-bell';
    approvals.type='button';
    approvals.hidden=true;
    approvals.title='Mis aprobaciones';
    approvals.setAttribute('aria-label','Abrir mis aprobaciones');
    approvals.innerHTML='<span aria-hidden="true">🔔</span> <b>0</b>';
    approvals.onclick=()=>openWorkspace('/approval-inbox.html','Workflow','Mis aprobaciones');

    taxes=document.createElement('button');
    taxes.className='nexo-alert-button nexo-tax-bell';
    taxes.type='button';
    taxes.title='Alertas del calendario tributario';
    taxes.setAttribute('aria-label','Abrir alertas del calendario tributario');
    taxes.innerHTML='<span aria-hidden="true">▣</span> <b>0</b>';
    taxes.hidden=true;
    taxes.onclick=()=>openWorkspace('/tax-calendar.html?notifications=1','Fiscal','Calendario tributario');
    document.body.append(approvals,taxes);

    style=document.createElement('style');
    style.textContent='.nexo-alert-button{position:fixed;bottom:18px;z-index:9000;border:0;border-radius:999px;background:#042e72;color:#fff;padding:11px 14px;box-shadow:0 5px 18px #042e7238;font-weight:700}.nexo-alert-button b{background:#fff;color:#042e72;border-radius:99px;padding:2px 6px}.nexo-approval-bell{right:18px}.nexo-tax-bell{right:88px;background:#f26938}.nexo-tax-bell b{color:#c94b1f}.nexo-alert-button:focus-visible{outline:3px solid #f2693855;outline-offset:2px}';
    document.head.append(style);
  }

  function unmount(){
    approvals?.remove();taxes?.remove();style?.remove();
    approvals=null;taxes=null;style=null;
  }

  function schedule(delay){
    if(timer!==null)clearTimeout(timer);
    timer=window.setTimeout(()=>{timer=null;void poll();},delay);
  }

  async function poll(){
    if(document.hidden)return;
    const sequence=++pollSequence;
    const {token,device}=credentials(),scope=contextKey();
    if(scope!==lastScope){unmount();lastScope=scope;}
    if(!token){
      controller?.abort();controller=null;unmount();schedule(AUTH_RETRY_MS);return;
    }
    mount();
    controller?.abort();
    controller=new AbortController();
    const headers={Authorization:`Bearer ${token}`,'X-Device-Token':device};
    const today=dateFormatter.format(new Date());
    const [approvalResult,taxResult]=await Promise.allSettled([
      fetch('/api/approval-engine/inbox',{headers,signal:controller.signal,cache:'no-store'}),
      fetch('/api/tax-calendar/list',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({dateFrom:today,dateTo:today}),signal:controller.signal,cache:'no-store'})
    ]);
    const current=()=>sequence===pollSequence&&!document.hidden&&scope===contextKey();
    if(!current()){if(sequence===pollSequence){unmount();schedule(0);}return;}
    if(approvalResult.status==='fulfilled')try{
      const data=await approvalResult.value.json();
      if(current()&&approvals){approvals.querySelector('b').textContent=approvalResult.value.ok?String(Array.isArray(data)?data.length:0):'0';approvals.hidden=!approvalResult.value.ok;}
    }catch{if(current()&&approvals){approvals.hidden=true;approvals.querySelector('b').textContent='0';}}
    if(taxResult.status==='fulfilled')try{
      const data=await taxResult.value.json(),count=(data.notifications||[]).filter(item=>!item.readAt).length;
      if(current()&&taxResult.value.ok&&taxes){taxes.querySelector('b').textContent=count>99?'99+':String(count);taxes.hidden=!count;}
    }catch{if(current()&&taxes){taxes.hidden=true;taxes.querySelector('b').textContent='0';}}
    if(!current()&&sequence===pollSequence){unmount();schedule(0);return;}
    if(current()){if(approvalResult.status==='rejected'&&approvals){approvals.hidden=true;approvals.querySelector('b').textContent='0';}if((taxResult.status==='rejected'||!taxResult.value.ok)&&taxes){taxes.hidden=true;taxes.querySelector('b').textContent='0';}schedule(POLL_INTERVAL_MS);}
  }

  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      if(timer!==null)clearTimeout(timer);
      timer=null;pollSequence+=1;controller?.abort();controller=null;
    }else schedule(0);
  });
  window.addEventListener('focus',()=>schedule(0));
  window.addEventListener('storage',event=>{if(['nexo_token','nexo_device_token','nexo_role','nexo_company'].includes(event.key)||event.key===null)resetContext();});
  window.addEventListener('nexo:approval-context-changed',resetContext);
  window.addEventListener('pagehide',()=>controller?.abort(),{once:true});
  schedule(0);
})();
