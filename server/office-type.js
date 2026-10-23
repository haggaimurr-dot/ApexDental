const {inflateRawSync}=require('node:zlib')
const {fail}=require('./archive-common')
function officeArchiveType(bytes){
 if(bytes.length<22)return null
 let end=-1;for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50){end=offset;break}
 if(end<0)return null
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16)
 if(count>10000||start+size>end||end+22+bytes.readUInt16LE(end+20)!==bytes.length)return null
 let offset=start,total=0,main=null,types=false
 for(let index=0;index<count;index++){
  if(offset+46>start+size||bytes.readUInt32LE(offset)!==0x02014b50)return null
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),compressed=bytes.readUInt32LE(offset+20),uncompressed=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42)
  if(offset+46+nameLength+extra+comment>start+size||local+30>start||flags&1||![0,8].includes(method))return null
  const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');total+=uncompressed;if(total>64*1024*1024)fail(413,'Office附件解压总量超过64 MB')
  if(name==='[Content_Types].xml')types=true
  if(name==='word/document.xml'||name==='xl/workbook.xml'){
   if(bytes.readUInt32LE(local)!==0x04034b50||uncompressed>8*1024*1024)return null
   const dataStart=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);if(dataStart+compressed>start)return null
   let data;try{data=method===0?bytes.subarray(dataStart,dataStart+compressed):inflateRawSync(bytes.subarray(dataStart,dataStart+compressed),{maxOutputLength:8*1024*1024})}catch{return null}
   if(data.length!==uncompressed)return null
   const xml=data.toString('utf8');if(name==='word/document.xml'&&/<(?:\w+:)?document\b/.test(xml))main='application/vnd.openxmlformats-officedocument.wordprocessingml.document';if(name==='xl/workbook.xml'&&/<(?:\w+:)?workbook\b/.test(xml))main='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  offset+=46+nameLength+extra+comment
 }
 return types&&offset===start+size?main:null
}
module.exports={officeArchiveType}
