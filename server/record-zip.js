// ZIP with stored entries; no external dependency and no executable export format.
function zipFiles(files,maxBytes = 64*1024*1024) {
  const { fail } = require('./archive-common')
  if (files.length > 65535) fail(413,'导出文件过多，请联系诊所分批办理')
  const table = Array.from({ length: 256 },(_,n) => { let c=n; for (let k=0;k<8;k++) c=c&1 ? 0xedb88320^(c>>>1) : c>>>1; return c>>>0 })
  const crc = data => { let c=0xffffffff; for (const byte of data) c=table[(c^byte)&255]^(c>>>8); return (c^0xffffffff)>>>0 }
  const parts = [],directory = []; let offset=0
  for (const file of files) {
    const name = Buffer.from(file.name,'utf8'),data = Buffer.from(file.bytes),checksum=crc(data)
    if (offset+data.length+name.length+30 > maxBytes) fail(413,'资料包超过 64 MB，请联系诊所分批办理')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6)
    header.writeUInt16LE(0x21,12); header.writeUInt32LE(checksum,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x800,8); central.writeUInt16LE(0x21,14)
    central.writeUInt32LE(checksum,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42)
    directory.push(central,name); parts.push(header,name,data); offset+=header.length+name.length+data.length
  }
  const central = Buffer.concat(directory),end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(central.length,12); end.writeUInt32LE(offset,16)
  if (offset+central.length+end.length > maxBytes) fail(413,'资料包超过 64 MB，请联系诊所分批办理')
  return Buffer.concat([...parts,central,end])
}
module.exports = { zipFiles }
