window.NexoBudgetFeedback={handle(result){
 if(!result||(!result.budgetPending&&!result.budgetWarnings?.length))return;
 let panel=document.getElementById('budgetFeedback');if(!panel){panel=document.createElement('aside');panel.id='budgetFeedback';panel.setAttribute('role','status');panel.style.cssText='margin:16px;padding:16px;border:1px solid #e9b949;border-radius:8px;background:#fff9e6;color:#6b4500;';(document.querySelector('main')||document.body).prepend(panel);}
 panel.replaceChildren();const text=document.createElement('p');text.textContent=result.budgetPending?`${result.message} Solicitud #${result.budgetRequestId}.`:`Advertencia presupuestaria: ${result.budgetWarnings.map(v=>`${v.account} / ${v.center}: disponible ${Number(v.available).toLocaleString('es-CR')}`).join('; ')}.`;
 const link=document.createElement('a');link.href='/apps/budget/dashboard';link.textContent='Ver control presupuestario';panel.append(text,link);panel.scrollIntoView({block:'center'});
 if(result.budgetPending)throw Error(text.textContent);
}};
