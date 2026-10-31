import {bankCheckRpc} from './bank-check.service.js';
export const bankCheckPeriods=(authorization:string)=>bankCheckRpc(authorization,'view','bank_check_periods');
