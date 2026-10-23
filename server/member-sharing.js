const { randomUUID,randomBytes,createHash } = require('node:crypto')
function createMemberSharing(db) {
  let guardians
  db.exec(`CREATE TABLE IF NOT EXISTS member_share_invites (
    id TEXT PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,member_id TEXT NOT NULL,owner_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,used_by TEXT,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
    FOREIGN KEY(member_id) REFERENCES family_members(id)
  );CREATE TABLE IF NOT EXISTS member_shares (
    id TEXT PRIMARY KEY,member_id TEXT NOT NULL,owner_id TEXT NOT NULL,user_id TEXT NOT NULL,
    recipient_name TEXT NOT NULL,enabled INTEGER NOT NULL,invite_hash TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(member_id,user_id),FOREIGN KEY(member_id) REFERENCES family_members(id)
  );`)
  function fail(status,message) { const error = new Error(message); error.status = status; throw error }
  function hash(code) { return createHash('sha256').update(code).digest('hex') }
  function normalize(code) { if (typeof code !== 'string' || !/^[A-Fa-f0-9]{18}$/.test(code.trim())) fail(400,'请输入 18 位家庭授权码'); return code.trim().toUpperCase() }
  function owned(user,id) {
    const row = db.prepare('SELECT * FROM family_members WHERE id=? AND owner_id=?').get(id,user.id)
    if (!row) fail(403,'只有档案管理人可以授权或撤销')
    return row
  }
  function canRead(user,appointment) {
    if (appointment.owner_id === user.id) return true
    if (!appointment.member_id) return false
    if (guardians?.needs(appointment.member_id) && !guardians.verified(appointment.member_id,appointment.owner_id)) return false
    return !!db.prepare('SELECT 1 FROM member_shares s JOIN family_members m ON m.id=s.member_id WHERE s.member_id=? AND s.user_id=? AND s.enabled=1 AND s.owner_id=? AND m.owner_id=s.owner_id').get(appointment.member_id,user.id,appointment.owner_id)
  }
  const readableCondition = `(a.owner_id=? OR EXISTS (SELECT 1 FROM member_shares s JOIN family_members m ON m.id=s.member_id WHERE s.member_id=a.member_id AND s.user_id=? AND s.enabled=1 AND s.owner_id=a.owner_id AND m.owner_id=s.owner_id AND (NOT EXISTS (SELECT 1 FROM member_health_profiles h WHERE h.member_id=m.id AND h.minor_required=1) OR EXISTS (SELECT 1 FROM guardian_checks g WHERE g.member_id=m.id AND g.owner_id=m.owner_id AND g.status='approved'))))`
  function invite(user,id) {
    const member = owned(user,id)
    guardians?.requireVerified(user,id)
    if (!member.enabled) fail(409,'请先启用成员档案再授权')
    const code = randomBytes(9).toString('hex').toUpperCase(), timestamp = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString()
    const inviteId = `MSI-${randomUUID()}`
    db.prepare('INSERT INTO member_share_invites VALUES (?,?,?,?,?,NULL,0,?)').run(inviteId,hash(code),id,user.id,expiresAt,timestamp)
    db.prepare('INSERT INTO member_events (member_id,action,actor,created_at) VALUES (?,?,?,?)').run(id,'share_invited',user.id,timestamp)
    return { id: inviteId,code,expiresAt,memberName: member.name }
  }
  function lookup(user,code) {
    const row = db.prepare('SELECT i.*,m.name,m.enabled FROM member_share_invites i JOIN family_members m ON m.id=i.member_id AND m.owner_id=i.owner_id WHERE i.code_hash=?').get(hash(normalize(code)))
    if (!row || row.revoked || row.expires_at < new Date().toISOString()) fail(409,'授权码无效、已撤销或已过期')
    if (row.owner_id === user.id) fail(409,'请由家人使用自己的微信账号接受授权')
    if (!row.enabled) fail(409,'该成员已停用，请联系档案管理人')
    if (guardians?.needs(row.member_id) && !guardians.verified(row.member_id,row.owner_id)) fail(409,'该成员的监护核验尚未通过或已撤销')
    return row
  }
  function preview(user,code) {
    const row = lookup(user,code)
    if (row.used_by) fail(409,'授权码已使用')
    return { memberName: row.name,expiresAt: row.expires_at, scope: 'member-records-readonly', scopeLabel: '成员已有及后续的预约、结构化治疗记录、统一时间轴、护理反馈、复查、就诊归档及已提交恢复照片' }
  }
  function accept(user,body) {
    if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 40) fail(400,'请填写您的姓名或称呼（最多 40 字）')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = lookup(user,body.code)
      const existing = db.prepare('SELECT * FROM member_shares WHERE member_id=? AND user_id=?').get(row.member_id,user.id)
      if (row.used_by) {
        if (row.used_by === user.id && existing && existing.enabled && existing.invite_hash === row.code_hash) { db.exec('COMMIT'); return { memberId: row.member_id } }
        fail(409,'授权码已使用，重新授权请向管理人获取新码')
      }
      const timestamp = new Date().toISOString()
      db.prepare('INSERT INTO member_shares VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(member_id,user_id) DO UPDATE SET enabled=1,recipient_name=excluded.recipient_name,invite_hash=excluded.invite_hash,created_at=excluded.created_at').run(`MS-${randomUUID()}`,row.member_id,row.owner_id,user.id,body.displayName.trim(),row.code_hash,timestamp)
      db.prepare('UPDATE member_share_invites SET used_by=? WHERE id=?').run(user.id,row.id)
      db.prepare('INSERT INTO member_events (member_id,action,actor,created_at) VALUES (?,?,?,?)').run(row.member_id,'share_accepted',user.id,timestamp)
      db.exec('COMMIT'); return { memberId: row.member_id }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function list(user,id) {
    owned(user,id)
    return { shares: db.prepare('SELECT id,recipient_name AS recipientName,enabled,created_at AS createdAt FROM member_shares WHERE member_id=? ORDER BY created_at DESC').all(id),
      invites: db.prepare('SELECT id,expires_at AS expiresAt,created_at AS createdAt FROM member_share_invites WHERE member_id=? AND used_by IS NULL AND revoked=0 AND expires_at>? ORDER BY created_at DESC').all(id,new Date().toISOString()) }
  }
  function revoke(user,id,isInvite) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const table = isInvite ? 'member_share_invites' : 'member_shares'
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`).get(id,user.id)
      if (!row) fail(403,'无权撤销此授权')
      if (isInvite && row.used_by) fail(409,'邀请已接受，请在授权名单中撤销访问')
      db.prepare(`UPDATE ${table} SET ${isInvite ? 'revoked=1' : 'enabled=0'} WHERE id=?`).run(id)
      db.prepare('INSERT INTO member_events (member_id,action,actor,created_at) VALUES (?,?,?,?)').run(row.member_id,isInvite ? 'share_invite_revoked' : 'share_revoked',user.id,new Date().toISOString())
      db.exec('COMMIT'); return { revoked: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { canRead,readableCondition,invite,preview,accept,list,revoke,setGuardians: value => { guardians = value } }
}
module.exports = { createMemberSharing }
