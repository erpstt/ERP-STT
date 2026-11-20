export function payrollGroups(rows){
 const accounts=new Map(),currencies=new Map();
 const sum=(t,r)=>{for(const k of['debit','credit','net','debitOriginal','creditOriginal','netOriginal'])t[k]=(t[k]||0)+Number(r[k]||0);};
 for(const row of rows){const key=String(row.currencyId??row.currency??'UNKNOWN');if(!accounts.has(row.accountId))accounts.set(row.accountId,{id:row.accountId,number:row.accountNumber,name:row.accountName,currencies:new Map(),net:0});const account=accounts.get(row.accountId);account.net+=Number(row.net);
  if(!account.currencies.has(key))account.currencies.set(key,{key,code:row.currency||'Sin moneda',notes:new Map()});const currency=account.currencies.get(key);sum(currency,row);if(!currency.notes.has(row.note))currency.notes.set(row.note,[]);currency.notes.get(row.note).push(row);
  if(!currencies.has(key))currencies.set(key,{key,code:currency.code});sum(currencies.get(key),row);
 }
 const ordered=[...accounts.values()].sort((a,b)=>a.number.localeCompare(b.number));for(const a of ordered)a.currencies=[...a.currencies.values()].sort((a,b)=>a.code.localeCompare(b.code));
 return {accounts:ordered,currencies:[...currencies.values()].sort((a,b)=>a.code.localeCompare(b.code))};
}
