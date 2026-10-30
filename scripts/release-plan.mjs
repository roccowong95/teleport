import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
let release=false,version='0.1.0';
const ref=process.env.GITHUB_REF||'';
if(process.env.EVENT_NAME==='push' && ref.startsWith('refs/tags/')){version=ref.slice('refs/tags/'.length);release=true;}
else if(process.env.EVENT_NAME==='push' && ref==='refs/heads/main'){
 const before=process.env.BEFORE||'';
 if(/^[a-f0-9]{40}$/.test(before)&&!/^0+$/.test(before)){
  const changed=execFileSync('git',['diff','--name-only',before,process.env.GITHUB_SHA],{encoding:'utf8'}).trim().split('\n');
  if(changed.includes('.github/release-request.json')){const request=JSON.parse(readFileSync('.github/release-request.json','utf8'));if(request.version!=='v0.1.0-alpha.1'||request.release!==true)throw Error('Only the explicitly approved initial prerelease request is supported');version=request.version;release=true;}
 }
}
if(!/^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)&&release)throw Error('Only prerelease semantic-version tags are supported');
console.log(`release=${release}\nversion=${version}`);
