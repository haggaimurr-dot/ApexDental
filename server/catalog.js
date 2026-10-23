const { randomUUID } = require('node:crypto')
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function createCatalog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS clinic_profile (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog_entries (id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL,UNIQUE(kind,name));
    CREATE TABLE IF NOT EXISTS catalog_events (id INTEGER PRIMARY KEY,actor TEXT NOT NULL,kind TEXT NOT NULL,entry_id TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`)
  db.exec("CREATE TABLE IF NOT EXISTS catalog_checks(doctor_id TEXT PRIMARY KEY,version INTEGER NOT NULL,kind TEXT NOT NULL,note TEXT NOT NULL,actor TEXT NOT NULL,checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS catalog_check_events(id INTEGER PRIMARY KEY,doctor_id TEXT NOT NULL,version INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL)")
  db.prepare('INSERT OR IGNORE INTO clinic_profile VALUES (1,?,1)').run(JSON.stringify({ name: 'ApexDental 口腔诊所', phone: '', address: '', hours: '', introduction: '' }))
  // Seed once: restarting must never restore disabled entries or overwrite maintained information.
  const seed = db.prepare('INSERT OR IGNORE INTO catalog_entries VALUES (?,?,?,?,1,1)')
  for (const name of ['李医生', '周医生']) seed.run(`doctor-${name}`, 'doctors', name, JSON.stringify({ title: '', license: '', specialties: '', introduction: '', serviceNames: [] }))
  for (const name of ['初次口腔检查', '洁牙护理', '牙齿不适咨询', '儿童口腔检查']) seed.run(`service-${name}`, 'services', name, JSON.stringify({ introduction: '', preparation: '', durationMinutes: 30 }))
  function admin(user) { if (user.role !== 'admin' || !user.isStaff) fail(403, '仅管理员可维护诊所资料') }
  function entries(kind, all = false) {
    return db.prepare(`SELECT * FROM catalog_entries WHERE kind=? ${all ? '' : 'AND enabled=1'} ORDER BY rowid`).all(kind)
      .map(row => {const check=kind==='doctors'?db.prepare('SELECT * FROM catalog_checks WHERE doctor_id=? AND version=?').get(row.id,row.version):null;return { ...JSON.parse(row.payload),id:row.id,name:row.name,enabled:!!row.enabled,version:row.version,...(kind==='doctors'?{verified:check?.kind==='verified',mockVerified:check?.kind==='mock',verifiedAt:check?.checked_at||'',...(all?{verificationNote:check?.note||''}:{})}:{})}}).filter(row=>kind!=='doctors'||all||process.env.APEX_DEMO_AUTH==='1'||row.verified)
  }
  function names(kind, all = false) { return entries(kind, all).map(row => row.name) }
  function clinic() { const row = db.prepare('SELECT * FROM clinic_profile WHERE id=1').get(); return { ...JSON.parse(row.payload), version: row.version } }
  function list(user, all = false) { if (all) admin(user); return { clinic: clinic(), doctors: entries('doctors', all), services: entries('services', all), doctorNames: names('doctors', true), serviceNames: names('services', true) } }
  function permits(doctor, service) {
    const row = entries('doctors').find(row => row.name === doctor)
    return !!row && (!service || names('services').includes(service) && (!row.serviceNames.length || row.serviceNames.includes(service)))
  }
  function text(body, field, max, required = false) {
    if (typeof body[field] !== 'string' || body[field].length > max || required && !body[field].trim()) fail(400, `请检查${({ name: '名称', phone: '联系电话', address: '地址', hours: '营业时间', introduction: '简介', title: '职称', license: '执业信息', specialties: '擅长项目', preparation: '预约准备' })[field] || '资料'}，最多 ${max} 字`)
    return body[field].trim()
  }
  function save(user, kind, body, id) {
    admin(user)
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '资料格式无效')
    if (!['clinic', 'doctors', 'services'].includes(kind)) fail(404, '资料类型不存在')
    const name = text(body, 'name', 60, true)
    if (['不限医生', '全部医生', '通用'].includes(name)) fail(400, '请使用其他名称')
    let payload
    if (kind === 'clinic') {
      payload = { name, phone: text(body, 'phone', 30), address: text(body, 'address', 300), hours: text(body, 'hours', 300), introduction: text(body, 'introduction', 2000) }
      if (payload.phone && !/^[0-9+()\-\s]{5,30}$/.test(payload.phone)) fail(400, '联系电话格式无效')
    } else {
      if (typeof body.enabled !== 'boolean') fail(400, '启用状态无效')
      payload = { introduction: text(body, 'introduction', 2000) }
      if (kind === 'doctors') {
        Object.assign(payload, { title: text(body, 'title', 100), license: text(body, 'license', 100), specialties: text(body, 'specialties', 500) })
        if (!Array.isArray(body.serviceNames) || body.serviceNames.length > 100 || new Set(body.serviceNames).size !== body.serviceNames.length || body.serviceNames.some(value => !names('services', true).includes(value))) fail(400, '适用服务项目无效')
        payload.serviceNames = body.serviceNames
      } else {
        payload.preparation = text(body, 'preparation', 2000)
        if (!Number.isSafeInteger(body.durationMinutes) || body.durationMinutes < 1 || body.durationMinutes > 480) fail(400, '参考时长应为 1–480 分钟')
        payload.durationMinutes = body.durationMinutes
      }
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = kind === 'clinic' ? clinic() : id ? entries(kind, true).find(row => row.id === id) : null
      if (kind !== 'clinic' && id && !previous) fail(404, '资料不存在')
      if (previous && previous.version !== body.version) fail(409, '资料已被修改，请重新加载后编辑')
      // Names are the legacy booking/role identity. Keep this key stable to preserve access to existing records.
      if (previous && kind !== 'clinic' && previous.name !== name) fail(409, '已保存的名称是关联标识，不能修改；请新增资料并停用旧资料')
      if (!previous && db.prepare('SELECT id FROM catalog_entries WHERE kind=? AND name=?').get(kind, name)) fail(409, '同名资料已存在，请编辑或恢复启用')
      const entryId = kind === 'clinic' ? '1' : previous ? previous.id : randomUUID(), version = (previous?.version || 0) + 1
      const result = { ...payload, name, version, ...(kind === 'clinic' ? {} : { id: entryId, enabled: body.enabled }) }
      if (kind === 'clinic') db.prepare('UPDATE clinic_profile SET payload=?,version=? WHERE id=1').run(JSON.stringify(payload), version)
      else db.prepare(`INSERT INTO catalog_entries VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,enabled=excluded.enabled,version=excluded.version`).run(entryId, kind, name, JSON.stringify(payload), Number(body.enabled), version)
      db.prepare('INSERT INTO catalog_events (actor,kind,entry_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?)').run(user.id, kind, entryId, previous ? JSON.stringify(previous) : null, JSON.stringify(result), new Date().toISOString())
      db.exec('COMMIT'); return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function verify(user,id,body){
    admin(user)
    const row=entries('doctors',true).find(item=>item.id===id)
    if(!row)fail(404,'医生资料不存在')
    if(row.version!==body?.version)fail(409,'医生资料已变更，请重新核验')
    if(body.identityChecked!==true||body.qualificationChecked!==true||!row.license.trim())fail(400,'需填写执业信息并明确核对身份与执业资料')
    const note=text(body,'note',1000,true),mock=row.name.includes('Mock')||row.license.includes('Mock')
    if(mock&&process.env.APEX_DEMO_AUTH!=='1')fail(400,'Mock资料不能作为正式执业核验')
    db.exec('BEGIN IMMEDIATE');try{const now=new Date().toISOString();db.prepare('INSERT INTO catalog_checks VALUES(?,?,?,?,?,?) ON CONFLICT(doctor_id) DO UPDATE SET version=excluded.version,kind=excluded.kind,note=excluded.note,actor=excluded.actor,checked_at=excluded.checked_at').run(id,row.version,mock?'mock':'verified',note,user.id,now);db.prepare('INSERT INTO catalog_check_events(doctor_id,version,actor,note,created_at) VALUES(?,?,?,?,?)').run(id,row.version,user.id,note,now);db.exec('COMMIT');return list(user,true)}catch(error){db.exec('ROLLBACK');throw error}
  }
  return { list, save, names, permits, entries, verify }
}
module.exports = { createCatalog }
