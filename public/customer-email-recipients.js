const emailPattern=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** Customer invoice/statement recipients: comma or semicolon separated, never headers. */
export function parseCustomerEmailRecipients(value){
 const source=String(value??'');
 const fail=()=>{throw Object.assign(Error('Ingrese correos electr\u00f3nicos v\u00e1lidos separados por coma o punto y coma (m\u00e1ximo 20).'),{status:400});};
 if(source.length>6000||/[\u0000-\u001f\u007f]/.test(source))fail();
 const emails=[],seen=new Set();
 for(const part of source.split(/[,;]/)){
  const email=part.trim();if(!email)continue;
  const local=email.split('@')[0];
  if(email.length>254||local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!emailPattern.test(email))fail();
  const key=email.toLowerCase();if(!seen.has(key)){seen.add(key);emails.push(email);}
 }
 if(emails.length>20)fail();return emails;
}
