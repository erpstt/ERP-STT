import{withDeviceContext}from'../../../core/security/device-context.js';
import{assertRequestAccess}from'./request-access.service.js';
export async function assertRegisteredDevice(authorization:string,token:string|undefined){return withDeviceContext(token,()=>assertRequestAccess(authorization,token));}
