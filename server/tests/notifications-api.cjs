const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-notifications-'))
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
    const db = new DatabaseSync(database), next = new Date(Date.now() + 48 * 3600000 + 8 * 3600000).toISOString().slice(0, 10), stamp = new Date().toISOString()
    db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,created_at,updated_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('notification-visit','notification-request','测试患者','13800000000','洁牙护理','李医生',next,'10:00','已预约','测试',stamp,stamp,patient.profile.id)
    db.prepare('INSERT INTO events (appointment_id,to_status,actor,created_at) VALUES (?,?,?,?)').run('notification-visit','已预约',admin.profile.id,stamp)
    db.close()
    await request('GET', '/v1/notifications', '', undefined, 401)
    await request('GET', '/v1/admin/notifications', patient.token, undefined, 403)
    const list = await request('GET', '/v1/notifications', patient.token)
    assert.equal(list.total, 1); assert.equal(list.unread, 1)
    const id = list.items[0].id
    assert.equal((await request('GET', '/v1/notifications', other.token)).total, 0)
    await request('POST', `/v1/notifications/${id}/read`, other.token, {}, 404)
    await request('POST', `/v1/admin/notifications/${id}/retry`, patient.token, {}, 403)
    await request('POST', `/v1/notifications/${id}/read`, patient.token, {})
    assert.equal((await request('GET', '/v1/notifications', patient.token)).unread, 0)
    assert.equal((await request('GET', '/v1/notifications/settings', patient.token)).ready, false)
    await request('POST', '/v1/notifications/subscriptions', patient.token, { choices: [{ templateId: 'unknown', choice: 'accept' }] }, 400)
    await request('GET', '/v1/notifications?page=0', patient.token, undefined, 400)
    assert.equal((await request('GET', '/v1/admin/notifications', admin.token)).total, 1)
    console.log('PASS: authenticated notification API, confirmation enqueue, owner isolation, admin permissions, read receipt and configuration validation')
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, 'exit')
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
