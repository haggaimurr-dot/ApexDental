const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-confirmations-'))
  const database = path.join(directory, 'check.sqlite'), port = 21000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APEX_DEMO_AUTH: '1', APEX_PORT: String(port), APEX_DATA_DIR: directory, APEX_DB_PATH: database, APEX_WECHAT_APPID: '', APEX_WECHAT_SECRET: '', APEX_WECHAT_TEMPLATES: '{}' } })
  let output = ''; child.stderr.on('data', chunk => { output += chunk }); child.stdout.resume()
  async function request(method, route, token, body, expected = 200) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(4000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result
  }
  try {
    let ready = false
    for (let i = 0; i < 40; i++) { try { await request('GET', '/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
    assert.ok(ready, output)
    const patient = await request('POST', '/v1/auth/demo', '', { deviceId: 'notification-patient-device' })
    const other = await request('POST', '/v1/auth/demo', '', { deviceId: 'notification-other-device' })
    const admin = await request('POST', '/v1/auth/demo', '', { deviceId: 'notification-admin-device' })
    await request('POST', '/v1/staff/claim', admin.token, { code: fs.readFileSync(path.join(directory, 'bootstrap-code.txt'), 'utf8').trim(), displayName: '消息管理员' })
    const invite = await request('POST', '/v1/staff/invites', admin.token, { role: 'frontdesk' }, 201)
    const desk = await request('POST', '/v1/auth/demo', '', { deviceId: 'confirmation-frontdesk' })
    await request('POST', '/v1/staff/claim', desk.token, { code: invite.code, displayName: '预约前台' })
    const doctorInvite = await request('POST', '/v1/staff/invites', admin.token, { role: 'doctor', doctorName: '李医生' }, 201)
    const doctor = await request('POST', '/v1/auth/demo', '', { deviceId: 'confirmation-doctor' })
    await request('POST', '/v1/staff/claim', doctor.token, { code: doctorInvite.code, displayName: '接诊医生' })
    const db = new DatabaseSync(database), stamp = new Date().toISOString()
    db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,note,created_at,updated_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('confirmation-visit','confirmation-request','测试患者','13800000000','洁牙护理','李医生','2026-10-05','10:00','待确认','测试','患者原备注',stamp,stamp,patient.profile.id)
    const route = '/v1/appointments/confirmation-visit/status'
    const body = { status: '已预约', version: 0, communicationNote: '电话联系，患者已确认到诊时间。' }
    await request('PATCH', route, patient.token, body, 403)
    await request('PATCH', route, other.token, body, 403)
    await request('PATCH', route, doctor.token, body, 403)
    for (const note of [undefined, '', '   ', 42, '字'.repeat(501)])
      await request('PATCH', route, desk.token, { ...body, communicationNote: note }, 400)
    await request('PATCH', route, desk.token, { ...body, version: 9 }, 409)
    assert.equal(db.prepare('SELECT count(*) AS n FROM appointment_confirmations').get().n, 0)
    assert.equal(db.prepare('SELECT status FROM appointments').get().status, '待确认')
    await request('PATCH', route, desk.token, body)
    await request('PATCH', route, desk.token, body, 409)
    const record = db.prepare('SELECT * FROM appointment_confirmations').get()
    assert.equal(record.actor_id, desk.profile.id); assert.equal(record.actor_name, '预约前台')
    assert.equal(record.actor_role, 'frontdesk'); assert.equal(record.note, body.communicationNote)
    assert.equal(record.date, '2026-10-05'); assert.equal(record.slot, '10:00')
    assert.ok(Number.isFinite(Date.parse(record.created_at)))
    assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE to_status=?').get('已预约').n, 1)
    const details = (await request('GET', '/v1/appointments/confirmation-visit/reschedule?scope=clinic', desk.token)).appointment
    assert.equal(details.phone, '13800000000'); assert.equal(details.note, '患者原备注'); assert.equal(details.confirmations.length, 1)
    const mine = (await request('GET', '/v1/appointments/confirmation-visit/reschedule?scope=mine', patient.token)).appointment
    assert.equal(mine.confirmations, undefined)
    await request('GET', '/v1/appointments/confirmation-visit/reschedule?scope=clinic', patient.token, undefined, 403)
    const history = (await request('GET', '/v1/appointments/confirmation-visit/history?scope=clinic', admin.token)).history
    assert.ok(history.entries.some(entry => entry.title === '预约确认沟通记录' && entry.text.includes(body.communicationNote)))
    const patientHistory = (await request('GET', '/v1/appointments/confirmation-visit/history?scope=mine', patient.token)).history
    assert.ok(!patientHistory.entries.some(entry => entry.title === '预约确认沟通记录'))
    // A later pending booking gets a fresh record; old time and author snapshots remain intact.
    db.prepare("UPDATE appointments SET status='待确认',date='2026-10-06',slot='11:00',booking_version=booking_version+1").run()
    await request('PATCH', route, admin.token, { ...body, version: 1 }, 409)
    await request('PATCH', route, admin.token, { ...body, version: 2, communicationNote: '改期后已重新联系确认' })
    const records = db.prepare('SELECT * FROM appointment_confirmations ORDER BY id').all()
    assert.equal(records.length, 2); assert.equal(records[0].date, '2026-10-05'); assert.equal(records[1].date, '2026-10-06')
    assert.equal(records[1].actor_role, 'admin')
    // Keeping an appointment after a cancellation request is not a new booking confirmation.
    await request('PATCH', route, patient.token, { status: '取消申请中', version: 3 })
    await request('PATCH', route, desk.token, { status: '已预约', version: 4 })
    assert.equal(db.prepare('SELECT count(*) AS n FROM appointment_confirmations').get().n, 2)
    db.close()
    console.log('PASS: confirmation validation, roles, atomic audit, stale/repeated submission, snapshots, details and internal visibility')
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, 'exit')
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
