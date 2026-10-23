const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, createHash, randomUUID } = require('node:crypto')

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function issueCode() { return randomBytes(9).toString('hex').toUpperCase() }
function problem(status, message) { const error = new Error(message); error.status = status; throw error }

function createAuth(db, dataDir, catalog) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS staff (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, doctor_name TEXT, display_name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, role TEXT NOT NULL, doctor_name TEXT, expires_at TEXT NOT NULL, used_by TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bootstrap (code_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS account_closures (user_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS closed_subjects (subject_hash TEXT PRIMARY KEY,created_at TEXT NOT NULL);
  `)
  if (!db.prepare('PRAGMA table_info(staff)').all().some(row => row.name === 'doctor_name')) db.exec('ALTER TABLE staff ADD COLUMN doctor_name TEXT')
  if (!db.prepare('PRAGMA table_info(staff)').all().some(row => row.name === 'display_name')) db.exec("ALTER TABLE staff ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
  if (!db.prepare('PRAGMA table_info(invites)').all().some(row => row.name === 'doctor_name')) db.exec('ALTER TABLE invites ADD COLUMN doctor_name TEXT')

  const bootstrapFile = path.join(dataDir, 'bootstrap-code.txt')
  const admin = db.prepare("SELECT 1 FROM staff WHERE role='admin' AND enabled=1 LIMIT 1").get()
  if (!admin) {
    const code = issueCode()
    db.prepare('DELETE FROM bootstrap').run()
    db.prepare('INSERT INTO bootstrap (code_hash,consumed) VALUES (?,0)').run(digest(code))
    fs.writeFileSync(bootstrapFile, `${code}\n`, { mode: 0o600 })
    console.log(`首次管理员授权码已写入 ${bootstrapFile}`)
  } else if (fs.existsSync(bootstrapFile)) fs.unlinkSync(bootstrapFile)

  function profile(userId) {
    const staff = db.prepare('SELECT role,doctor_name,display_name FROM staff WHERE user_id=? AND enabled=1').get(userId)
    return { id: userId, role: staff ? staff.role : 'patient', doctorName: staff ? staff.doctor_name : null,
      displayName: staff ? staff.display_name : null, isStaff: !!staff }
  }
  function login(subject) {
    if (db.prepare('SELECT 1 FROM closed_subjects WHERE subject_hash=?').get(digest(subject))) problem(403,'账号已注销，当前身份不能重新登录')
    let user = db.prepare('SELECT id FROM users WHERE subject=?').get(subject)
    if (!user) {
      const id = randomUUID()
      db.prepare('INSERT INTO users VALUES (?,?,?)').run(id, subject, new Date().toISOString())
      user = { id }
    }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user.id, expiresAt)
    return { token, profile: profile(user.id), expiresAt }
  }
  function authenticate(req) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '')
    if (!match) problem(401, '请先登录')
    const session = db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(match[1]), new Date().toISOString())
    if (!session) problem(401, '登录已过期，请重新登录')
    if (db.prepare('SELECT 1 FROM account_closures WHERE user_id=?').get(session.user_id)) problem(401,'账号已注销')
    return profile(session.user_id)
  }
  function requireStaff(user) { if (!user.isStaff) problem(403, '仅诊所员工可访问') }
  function requireAdmin(user) { if (user.role !== 'admin') problem(403, '仅诊所管理员可操作') }

  function claim(user, code, displayName) {
    if (typeof code !== 'string' || !/^[A-F0-9]{18}$/.test(code.trim().toUpperCase())) problem(400, '授权码格式无效')
    if (typeof displayName !== 'string' || displayName.trim().length < 2 || displayName.trim().length > 40) problem(400, '请填写 2–40 字的员工姓名')
    const codeHash = digest(code.trim().toUpperCase())
    db.exec('BEGIN IMMEDIATE')
    try {
      let role, doctorName = null
      const firstAdmin = db.prepare('SELECT code_hash FROM bootstrap WHERE consumed=0').get()
      if (firstAdmin && firstAdmin.code_hash === codeHash) {
        role = 'admin'
        db.prepare('UPDATE bootstrap SET consumed=1 WHERE code_hash=? AND consumed=0').run(codeHash)
      } else {
        const invite = db.prepare('SELECT role,doctor_name FROM invites WHERE code_hash=? AND used_by IS NULL AND expires_at>?').get(codeHash, new Date().toISOString())
        if (!invite) problem(403, '授权码无效或已失效')
        role = invite.role
        doctorName = invite.doctor_name
        if (role === 'doctor' && !catalog.permits(doctorName)) problem(409, '该医生资料已停用，请联系管理员')
        db.prepare('UPDATE invites SET used_by=? WHERE code_hash=? AND used_by IS NULL').run(user.id, codeHash)
      }
      db.prepare('INSERT INTO staff (user_id,role,doctor_name,display_name,enabled,created_at) VALUES (?,?,?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,doctor_name=excluded.doctor_name,display_name=excluded.display_name,enabled=1').run(user.id, role, doctorName, displayName.trim(), new Date().toISOString())
      db.exec('COMMIT')
      if (role === 'admin' && fs.existsSync(bootstrapFile)) fs.unlinkSync(bootstrapFile)
      return profile(user.id)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function createInvite(user, role, doctorName) {
    requireAdmin(user)
    if (!['frontdesk', 'doctor', 'admin'].includes(role)) problem(400, '员工角色无效')
    if (role === 'doctor' && !catalog.permits(doctorName)) problem(400, '请选择医生身份')
    const code = issueCode()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO invites (code_hash,role,doctor_name,expires_at,used_by,created_at) VALUES (?,?,?,?,NULL,?)').run(digest(code), role, role === 'doctor' ? doctorName : null, expiresAt, new Date().toISOString())
    return { code, role, doctorName: role === 'doctor' ? doctorName : null, expiresAt }
  }
  function listStaff(user) {
    requireAdmin(user)
    return db.prepare('SELECT user_id AS id,role,doctor_name AS doctorName,display_name AS displayName,enabled FROM staff ORDER BY created_at').all()
  }
  function disableStaff(user, targetId) {
    requireAdmin(user)
    if (user.id === targetId) problem(409, '不能停用自己的管理员身份')
    const changed = db.prepare('UPDATE staff SET enabled=0 WHERE user_id=? AND enabled=1').run(targetId)
    if (!changed.changes) problem(404, '该员工不存在或已停用')
    return { ok: true }
  }
  return { login, profile, authenticate, requireStaff, requireAdmin, claim, createInvite, listStaff, disableStaff }
}

module.exports = { createAuth }
