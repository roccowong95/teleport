import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
test('embedded tray PNG has valid chunks, CRCs and complete pixel data',()=>{
 const source=readFileSync(new URL('../src/main.cjs',import.meta.url),'utf8');
 const png=Buffer.from(source.match(/data:image\/png;base64,([^']+)/)[1],'base64');
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 let offset=8,width,height,end=false;const compressed=[];
 while(offset<png.length){const n=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+n);
  assert.equal(crc32(png.subarray(offset+4,offset+8+n)),png.readUInt32BE(offset+8+n));
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[9],6);}
  if(type==='IDAT')compressed.push(data);if(type==='IEND')end=true;offset+=n+12;
 }
 assert.ok(end);assert.equal(offset,png.length);assert.equal(inflateSync(Buffer.concat(compressed)).length,height*(1+width*4));
});
