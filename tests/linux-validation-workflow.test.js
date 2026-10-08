'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const validation=fs.readFileSync(path.join(root,'.github/workflows/validate-cargorun-linux.yml'),'utf8');
const deployment=fs.readFileSync(path.join(root,'.github/workflows/deploy-cargorun.yml'),'utf8');

test('Linux validation workflow targets only the dedicated push branch',()=>{
 assert.match(validation,/^on:\r?\n  push:\r?\n    branches:\r?\n      - validation\/akl-runtime-linux\r?\n/m);
 assert.match(validation,/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/validation\/akl-runtime-linux'/);
 assert.doesNotMatch(validation,/^\s*(?:pull_request|pull_request_target|schedule|release|workflow_dispatch|workflow_run):/m);
 assert.match(deployment,/^on:\r?\n  push:\r?\n    branches:\r?\n      - main\r?\n/m);
 assert.doesNotMatch(deployment,/validation\/akl-runtime-linux/);
});

test('Linux validation workflow uses read-only checkout and runs only local validation',()=>{
 assert.match(validation,/^permissions:\r?\n  contents: read\r?\n/m);
 assert.match(validation,/runs-on: ubuntu-latest/);
 assert.match(validation,/node-version: '22\.23\.3'/);
 assert.match(validation,/npm install --global npm@11\.11\.0 --ignore-scripts --no-audit --no-fund/);
 assert.match(validation,/persist-credentials: false/);
 assert.match(validation,/run: node scripts\/validate-linux-release\.js/);
 assert.doesNotMatch(validation,/Azure\/static-web-apps-deploy|AZURE_|secrets\.|deployment[_ -]?token|upload-artifact|gh release|git push|sqlcmd|environment:/i);
});

test('Linux validator checks scoped production approval and locally inspects the package',()=>{
 const validator=fs.readFileSync(path.join(root,'scripts/validate-linux-release.js'),'utf8');
 assert.match(validator,/dependency-security-gate\.js','--context','testing'/);
 assert.match(validator,/dependency-security-gate\.js','--context','production'/);
 assert.match(validator,/requireApprovedProductionResult\(productionGate\)/);
 assert.match(validator,/'--context','production','--target',PRODUCTION_TARGET/);
 assert.match(validator,/scripts\/build-deployment-package\.js/);
 assert.match(validator,/const inventory=JSON\.parse/);
 assert.match(validator,/Linux repeat installation differs/);
 assert.doesNotMatch(validator,/Azure\/static-web-apps-deploy|az login|git push/);
});