// Current document endpoints convert IDs to Number. Preserve the decimal string
// only when it identifies an exact positive integer in that service contract.
export function readRouteId(search,key='id'){
 if(typeof search!=='string')return null;
 const values=new URLSearchParams(search).getAll(key);
 if(values.length!==1)return null;
 const value=values[0];
 return value.length<=16&&/^[1-9][0-9]*$/.test(value)&&Number.isSafeInteger(Number(value))?value:null;
}
