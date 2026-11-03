import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
let release=false, version='v0.3.0-alpha.1';
const event=process.env.EVENT_NAME||'',ref=process.env.GITHUB_REF||'';
if(event==='push'&&ref.startsWith('refs/tags/v0.3.')){version=ref.slice('refs/tags/'.length);release=true;}
else if(event==='push'&&ref==='refs/heads/main'){
 const before=process.env.BEFORE||'';
 if(/^[a-f0-9]{40}$/.test(before)&&!/^0+$/.test(before)){
  const changed=execFileSync('git',['diff','--name-only',before,process.env.GITHUB_SHA],{encoding:'utf8'}).trim().split('\n');
  if(changed.includes('.github/macos-release-request.json')){
   const request=JSON.parse(readFileSync('.github/macos-release-request.json','utf8'));
   if(request.version!=='v0.3.0-alpha.1'||request.release!==true)throw Error('Only approved lightweight macOS prerelease is supported');
   version=request.version;release=true;
  }
 }
}
if(!/^v0\.3\.\d+-[0-9A-Za-z.-]+$/.test(version))throw Error('Lightweight workflow accepts only v0.3 prerelease tags');
console.log(`release=${release}\nversion=${version}`);
