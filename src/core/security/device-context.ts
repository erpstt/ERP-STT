import{AsyncLocalStorage}from'node:async_hooks';import{createHash}from'node:crypto';
const context=new AsyncLocalStorage<string|null>();
export function withDeviceContext<T>(raw:string|undefined,operation:()=>T){const token=raw?.trim()??'';return context.run(token.length>=20&&token.length<=200?createHash('sha256').update(token).digest('hex'):null,operation);}
export function deviceContextHeaders(input:HeadersInit){const h=new Headers(input),hash=context.getStore();h.delete('x-erp-device-hash');if(hash)h.set('x-erp-device-hash',hash);return h;}
