const { randomUUID } = require('node:crypto')
const RELATIONS = ['本人', '子女', '父母', '配偶', '其他家人']
function createMembers(db) {
  let guardians
  db.exec(`CREATE TABLE IF NOT EXISTS family_members (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,relationship TEXT NOT NULL,
    phone TEXT NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL,
    request_key TEXT NOT NULL UNIQUE,updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS family_self ON family_members(owner_id) WHERE relationship='本人' AND enabled=1;
  CREATE TABLE IF NOT EXISTS member_events (id INTEGER PRIMARY KEY,member_id TEXT NOT NULL,appointment_id TEXT,action TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);`)
  if (!db.prepare('PRAGMA table_info(appointments)').all().some(row => row.name === 'member_id')) db.exec("ALTER TABLE appointments ADD COLUMN member_id TEXT NOT NULL DEFAULT ''")
  db.exec('CREATE INDEX IF NOT EXISTS appointments_member ON appointments(owner_id,member_id)')
  function fail(status, message) { const error = new Error(message); error.status = status; throw error }
  function view(row,shared = false) { return { id: row.id,name: row.name,relationship: shared ? '已授权查看' : row.relationship,phone: shared ? '' : row.phone,birthDate: shared ? '' : guardians?.birthDate(row.id) || '',guardianRequired: !!guardians?.needs(row.id),enabled: !!row.enabled,version: row.version,mayManage: !shared,shared } }
  // Stable IDs separate people even when names or contact numbers match.
  function all(user) { return db.prepare("SELECT m.* FROM family_members m WHERE m.owner_id=? OR EXISTS (SELECT 1 FROM member_shares s WHERE s.member_id=m.id AND s.owner_id=m.owner_id AND s.user_id=? AND s.enabled=1) ORDER BY m.enabled DESC,m.updated_at,m.id").all(user.id,user.id).filter(row => row.owner_id === user.id || !guardians?.needs(row.id) || guardians.verified(row.id,row.owner_id)).map(row => view(row,row.owner_id !== user.id)) }
  function owned(user, id, active = false) {
    if (typeof id !== 'string' || !id || id.length > 100) fail(400, '请选择家庭成员')
    const row = db.prepare('SELECT * FROM family_members WHERE id=? AND owner_id=?').get(id,user.id)
    if (!row) fail(403, '无权使用此成员档案')
    if (active && !row.enabled) fail(409, '该成员已停用，请先恢复档案')
    return row
  }
  function save(user, body, id) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400,'成员资料格式无效')
    if (body?.birthDate !== undefined && typeof body.birthDate !== 'string') fail(400,'出生日期格式无效')
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60 || !RELATIONS.includes(body.relationship) || !/^1\d{10}$/.test(body.phone || '') || typeof body.enabled !== 'boolean') fail(400, '请填写成员姓名、关系和有效的联系电话')
    if (id && (!Number.isSafeInteger(body.version) || body.version < 1)) fail(400, '成员版本无效')
    if (!id && (typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100)) fail(400, '缺少请求标识')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = id ? owned(user,id) : db.prepare('SELECT * FROM family_members WHERE request_key=?').get(body.requestKey)
      if (row && row.owner_id !== user.id) fail(403, '无权修改此成员档案')
      if (row && !id) { db.exec('COMMIT'); return view(row) }
      const name = body.name.trim(), enabled = Number(body.enabled)
      const same = row && row.name === name && row.phone === body.phone && row.relationship === body.relationship && row.enabled === enabled && (body.birthDate === undefined || body.birthDate === guardians?.birthDate(row.id))
      if (same && [body.version,body.version + 1].includes(row.version)) { db.exec('COMMIT'); return view(row) }
      if (row && row.version !== body.version) fail(409, '成员资料已更新，请返回后重新编辑')
      if (body.relationship === '本人' && enabled && db.prepare("SELECT 1 FROM family_members WHERE owner_id=? AND relationship='本人' AND enabled=1 AND id<>?").get(user.id,id || '')) fail(409, '已有启用的本人档案，请编辑已有档案')
      const memberId = row ? row.id : `FM-${randomUUID()}`, timestamp = new Date().toISOString()
      if (row) db.prepare('UPDATE family_members SET name=?,relationship=?,phone=?,enabled=?,version=version+1,updated_at=? WHERE id=?').run(name,body.relationship,body.phone,enabled,timestamp,memberId)
      else db.prepare('INSERT INTO family_members VALUES (?,?,?,?,?,?,?,?,?)').run(memberId,user.id,name,body.relationship,body.phone,enabled,1,body.requestKey,timestamp)
      guardians?.markProfile({ id: memberId,owner_id: user.id,relationship: body.relationship },body.birthDate)
      db.prepare('INSERT INTO member_events (member_id,action,actor,created_at) VALUES (?,?,?,?)').run(memberId,row ? 'updated' : 'created',user.id,timestamp)
      const saved = owned(user,memberId)
      db.exec('COMMIT'); return view(saved)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function assign(user, appointmentId, memberId) {
    db.exec('BEGIN IMMEDIATE')
    try {
      owned(user,memberId,true)
      let root = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId)
      if (!root || root.owner_id !== user.id) fail(403, '无权归属此预约')
      const seen = new Set()
      while (root.recall_id) {
        if (seen.has(root.id)) fail(409, '记录关联异常，请联系诊所')
        seen.add(root.id)
        root = db.prepare('SELECT * FROM appointments WHERE id=?').get(root.recall_id)
        if (!root || root.owner_id !== user.id) fail(403, '无权归属关联记录')
      }
      const rows = db.prepare('WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT a.id FROM appointments a JOIN chain c ON a.recall_id=c.id) SELECT a.* FROM appointments a JOIN chain c ON a.id=c.id').all(root.id)
      if (rows.some(row => row.owner_id !== user.id || row.member_id && row.member_id !== memberId)) fail(409, '关联记录已有其他成员归属，不能重新分配')
      for (const row of rows) if (!row.member_id) {
        db.prepare('UPDATE appointments SET member_id=? WHERE id=?').run(memberId,row.id)
        db.prepare('INSERT INTO member_events (member_id,appointment_id,action,actor,created_at) VALUES (?,?,?,?,?)').run(memberId,row.id,'assigned',user.id,new Date().toISOString())
      }
      db.exec('COMMIT'); return { assigned: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { list: all, owned, save, assign,setGuardians: value => { guardians = value } }
}
module.exports = { createMembers }
