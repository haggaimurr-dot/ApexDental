const { randomUUID, createHash } = require('node:crypto')
const MAX_SIZE = 3 * 1024 * 1024
function createCarePhotos(db,sharing) {
  db.exec(`CREATE TABLE IF NOT EXISTS care_photos (
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL,owner_id TEXT NOT NULL,mime TEXT NOT NULL,
    bytes BLOB NOT NULL,digest TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,
    attached INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES care_tasks(id)
  );CREATE INDEX IF NOT EXISTS care_photos_task ON care_photos(task_id,attached);`)
  function fail(status,message) { const error = new Error(message); error.status = status; throw error }
  function task(id) {
    const row = db.prepare('SELECT c.*,a.owner_id,a.member_id,a.doctor FROM care_tasks c JOIN appointments a ON a.id=c.appointment_id WHERE c.id=?').get(id)
    if (!row) fail(404,'护理任务不存在')
    return row
  }
  function access(user,row,attached) {
    if (row.owner_id === user.id) return
    if (attached && sharing.canRead(user,row)) return
    if (attached && (user.role === 'admin' || user.role === 'doctor' && row.doctor === user.doctorName)) return
    fail(403,'无权查看此护理照片')
  }
  function purge() { db.prepare('DELETE FROM care_photos WHERE attached=0 AND created_at<?').run(new Date(Date.now() - 86400000).toISOString()) }
  function metadata(row) { return { id: row.id,mime: row.mime,createdAt: row.created_at } }
  function list(user,id) {
    purge()
    const row = task(id), owner = row.owner_id === user.id
    access(user,row,row.status !== 'draft')
    const pending = owner && row.status === 'published'
    return db.prepare(`SELECT id,mime,created_at FROM care_photos WHERE task_id=? ${pending ? '' : 'AND attached=1'} ORDER BY created_at,id`).all(id).map(metadata)
  }
  function imageType(bytes) {
    if (bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
      if (!width || !height || width * height > 25000000) fail(400,'图片尺寸过大，请压缩后上传')
      return 'image/png'
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
      let offset = 2
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 255) break
        const marker = bytes[offset + 1]
        if (marker === 255) { offset++; continue }
        if (marker === 218 || marker === 217) break
        const length = bytes.readUInt16BE(offset + 2)
        if (length < 2 || offset + length + 2 > bytes.length) break
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
          const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7)
          if (!width || !height || width * height > 25000000) fail(400,'图片尺寸过大，请压缩后上传')
          return 'image/jpeg'
        }
        offset += length + 2
      }
    }
    fail(400,'请选择 JPEG 或 PNG 图片')
  }
  async function upload(user,id,key,req) {
    const initial = task(id)
    if (initial.owner_id !== user.id) fail(403,'只能上传自己的护理反馈照片')
    if (initial.status !== 'published') fail(409,'反馈已提交或任务尚未发送')
    if (typeof key !== 'string' || !key || key.length > 100) fail(400,'缺少图片请求标识')
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > MAX_SIZE) fail(413,'单张图片不能超过 3 MB，请压缩后上传'); chunks.push(chunk) }
    const bytes = Buffer.concat(chunks), mime = imageType(bytes), digest = createHash('sha256').update(bytes).digest('hex')
    purge()
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = task(id)
      if (current.owner_id !== user.id || current.status !== 'published') fail(409,'任务已变更，请重新加载')
      const existing = db.prepare('SELECT * FROM care_photos WHERE request_key=?').get(key)
      if (existing) {
        if (existing.task_id !== id || existing.owner_id !== user.id || existing.digest !== digest) fail(409,'图片请求标识已使用')
        db.exec('COMMIT'); return metadata(existing)
      }
      if (db.prepare('SELECT COUNT(*) AS total FROM care_photos WHERE task_id=?').get(id).total >= 3) fail(409,'每次反馈最多上传 3 张照片')
      const photo = { id: `CP-${randomUUID()}`,mime,created_at: new Date().toISOString() }
      db.prepare('INSERT INTO care_photos VALUES (?,?,?,?,?,?,?,0,?)').run(photo.id,id,user.id,mime,bytes,digest,key,photo.created_at)
      db.exec('COMMIT'); return metadata(photo)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function remove(user,id) {
    const photo = db.prepare('SELECT * FROM care_photos WHERE id=?').get(id)
    if (!photo) return { removed: true }
    const row = task(photo.task_id)
    if (row.owner_id !== user.id) fail(403,'无权删除此照片')
    if (photo.attached || row.status !== 'published') fail(409,'已提交反馈的照片不能删除')
    db.prepare('DELETE FROM care_photos WHERE id=?').run(id)
    return { removed: true }
  }
  function read(user,id) {
    const photo = db.prepare('SELECT * FROM care_photos WHERE id=?').get(id)
    if (!photo) fail(404,'照片不存在')
    if (!photo.attached && photo.created_at < new Date(Date.now() - 86400000).toISOString()) fail(410,'未提交的照片已过期，请重新上传')
    access(user,task(photo.task_id),!!photo.attached)
    return photo
  }
  return { list,upload,remove,read,imageType }
}
module.exports = { createCarePhotos }
