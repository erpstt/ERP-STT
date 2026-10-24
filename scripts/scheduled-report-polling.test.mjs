import assert from 'node:assert/strict';
import {scheduledReportPollMilliseconds} from '../dist/modules/reports/scheduled-reports.service.js';

assert.equal(scheduledReportPollMilliseconds(undefined),30000);
assert.equal(scheduledReportPollMilliseconds('15000'),15000);
assert.equal(scheduledReportPollMilliseconds('100'),5000);
assert.equal(scheduledReportPollMilliseconds('999999'),300000);
assert.equal(scheduledReportPollMilliseconds('invalid'),30000);

console.log(JSON.stringify({defaultPollMilliseconds:30000,min:5000,max:300000}));
