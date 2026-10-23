const { createHash } = require('node:crypto')
function fail(status,message) { const error = new Error(message); error.status = status; throw error }
const stamp = () => new Date().toISOString()
function text(value,max,label,optional = false) {
  if (typeof value !== 'string' || value.length > max || !optional && !value.trim()) fail(400,`${label}格式无效（最多 ${max} 字）`)
  return value.trim()
}
function transaction(db,action) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value }
function minor(birthDate) {
  if (!birthDate) return false
  const now = new Date(Date.now()+8*3600000).toISOString().slice(0,10), cutoff = `${Number(now.slice(0,4))-18}${now.slice(4)}`
  return birthDate > cutoff
}
async function fileBytes(req,photoTypes) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 10*1024*1024) fail(413,'附件不能超过 10 MB'); chunks.push(chunk) }
  const bytes = Buffer.concat(chunks)
  let mime
  if (bytes.length > 12 && bytes.subarray(0,5).toString() === '%PDF-' && bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) mime = 'application/pdf'
  else if (bytes.length > 132 && bytes.subarray(128,132).toString() === 'DICM') mime = 'application/dicom'
  else if(bytes.length>8 && (bytes.subarray(0,4).equals(Buffer.from([0x49,0x49,0x2a,0])) || bytes.subarray(0,4).equals(Buffer.from([0x4d,0x4d,0,0x2a])))) { await require('sharp')(bytes,{limitInputPixels:16*1024*1024}).metadata().catch(()=>fail(400,'TIFF图片无法解析')); mime='image/tiff' }
  else if(bytes.length>16 && ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())) {await require('sharp')(bytes,{limitInputPixels:16*1024*1024}).metadata().catch(()=>fail(400,'GIF图片无法解析'));mime='image/gif'}
  else if(bytes.length>32 && bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))) {mime=require('./office-type').officeArchiveType(bytes);if(!mime)fail(400,'Office附件格式或内容不完整')}
  else mime = photoTypes.imageType(bytes)
  return { bytes,mime,digest: createHash('sha256').update(bytes).digest('hex') }
}
module.exports = { fail,stamp,text,transaction,validDate,minor,fileBytes }
