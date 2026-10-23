const assert=require('node:assert/strict'),sharp=require('sharp')
const {imageQuality,registerImages,renderDicom}=require('../imaging')
function element(group,tag,vr,bytes){const wide=['OB','OW','SQ','UN','UT'].includes(vr),size=bytes.length+(bytes.length%2),header=Buffer.alloc(wide?12:8);header.writeUInt16LE(group,0);header.writeUInt16LE(tag,2);header.write(vr,4);wide?header.writeUInt32LE(size,8):header.writeUInt16LE(size,6);const content=Buffer.alloc(size);bytes.copy(content);return Buffer.concat([header,content])}
const us=value=>{const bytes=Buffer.alloc(2);bytes.writeUInt16LE(value);return bytes}
async function main(){
 const malformed=Buffer.from('not an image');await assert.rejects(imageQuality(malformed),error=>error.status===400)
 const flat=await sharp({create:{width:640,height:480,channels:3,background:'#ffffff'}}).png().toBuffer();const quality=await imageQuality(flat);assert.equal(quality.needsRetake,true);assert.ok(quality.issues.length>=2)
 const a=Buffer.alloc(96*96),b=Buffer.alloc(96*96)
 for(let y=0;y<96;y++)for(let x=0;x<96;x++){const value=((x*2654435761 ^ y*2246822519)>>>16)&255;a[y*96+x]=value;if(x+4<96&&y-3>=0)b[(y-3)*96+x+4]=value}
 const pngs=await Promise.all([a,b].map(bytes=>sharp(bytes,{raw:{width:96,height:96,channels:1}}).png().toBuffer()))
 const registration=await registerImages(...pngs);assert.equal(registration.reliable,true);assert.ok(Math.abs(registration.dx+4/96*100)<0.001);assert.ok(Math.abs(registration.dy-3/96*100)<0.001)
 assert.equal((await registerImages(flat,flat)).reliable,false)
 const preamble=Buffer.alloc(132);preamble.write('DICM',128)
 const dicom=Buffer.concat([preamble,element(2,16,'UI',Buffer.from('1.2.840.10008.1.2.1')),element(0x28,2,'US',us(1)),element(0x28,4,'CS',Buffer.from('MONOCHROME2')),element(0x28,0x10,'US',us(2)),element(0x28,0x11,'US',us(2)),element(0x28,0x100,'US',us(8)),element(0x28,0x101,'US',us(8)),element(0x28,0x102,'US',us(7)),element(0x28,0x103,'US',us(0)),element(0x7fe0,0x10,'OB',Buffer.from([0,64,128,255]))])
 const preview=await renderDicom(dicom,new URLSearchParams());assert.equal(preview.rows,2);assert.equal(preview.columns,2);assert.equal((await sharp(preview.bytes).metadata()).format,'png')
 await assert.rejects(renderDicom(dicom,new URLSearchParams('frame=2')),error=>error.status===400)
 await assert.rejects(renderDicom(dicom,new URLSearchParams('width=0')),error=>error.status===400)
 await assert.rejects(renderDicom(Buffer.from('invalid'),new URLSearchParams()),error=>error.status===422)
 console.log('PASS: actual raster decode/quality warnings, deterministic translation recovery, flat-image fallback, DICOM decode/window/frame validation and PNG rendering')
}
main().catch(error=>{console.error(error);process.exitCode=1})
