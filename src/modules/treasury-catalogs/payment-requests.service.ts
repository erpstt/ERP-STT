import {paymentRequestRpc,type RequestAction} from './payment-request-security.service.js';
import {paymentRequestApprovalTrace} from './payment-request-approval-trace.service.js';
const actions:Record<string,string>={access:'pr_access_context',options:'pr_options',invoices:'pr_invoices',report:'pr_report',detail:'pr_detail',save:'pr_save',transition:'pr_transition',execute:'pr_execute',supports:'pr_supports','support-save':'pr_support_save','support-delete':'pr_support_delete'};
export async function paymentRequests(auth:string,action:string,payload:Record<string,unknown>={}){
 const name=actions[action];if(!name)throw Object.assign(new Error('Solicitud no v\u00e1lida.'),{status:400});let permission:RequestAction;
 if(action==='access'||action==='options'||action==='invoices')permission='context';
 else if(action==='save')permission=payload.id===undefined||payload.id===null||payload.id===''?'create':'edit';
 else if(action==='execute')permission='edit';
 else if(action==='support-save'||action==='support-delete')permission='support';
 else if(action==='transition'){const t=String(payload.transition||'').toUpperCase();if(!['SUBMIT','APPROVE','REJECT','CANCEL'].includes(t))throw Object.assign(new Error('Transici\u00f3n inv\u00e1lida.'),{status:400});permission=t==='SUBMIT'?'edit':t==='CANCEL'?'delete':'view';}
 else permission='view';
 const result=await paymentRequestRpc(auth,name,['access','options'].includes(action)?{}:{p:payload},permission);
 if(action!=='detail')return result;
 return{...result,approvalTrace:await paymentRequestApprovalTrace(auth,result?.header?.id)};
}
