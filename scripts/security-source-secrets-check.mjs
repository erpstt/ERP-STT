import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkSourceSecrets,exitCode,publicFailure,SourceSecretsError} from './security-source-secrets-lib.mjs';

export async function main(){
 const result=process.argv.length===2?await checkSourceSecrets():publicFailure(new SourceSecretsError('ARGUMENTS_NOT_ALLOWED'),process.env.GITHUB_SHA);
 // Never print child streams, exception messages, source paths or raw findings.
 process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=exitCode(result);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
