export function pendingReversalLimit(pendingBalance,invoice){
  const balance=Math.max(0,Number(pendingBalance)||0);
  if(!invoice)return{maximum:balance,subtotal:null,applied:0,available:null};
  const subtotal=Math.max(0,Number(invoice.subtotal)||0);
  const applied=Math.max(0,Number(invoice.applied)||0);
  const available=Math.max(0,Number(invoice.available??subtotal-applied)||0);
  return{maximum:Math.min(balance,available),subtotal,applied,available};
}
