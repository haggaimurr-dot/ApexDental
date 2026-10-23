const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-record-requests-'))
  const database = path.join(directory, 'check.sqlite'), port = 21000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: { ...process.env, APEX_DEMO_AUTH: '1', APEX_PORT: String(port), APEX_DATA_DIR: directory, APEX_DB_PATH: database, APEX_WECHAT_APPID: '', APEX_WECHAT_SECRET: '', APEX_WECHAT_TEMPLATES: '{}' } })
  let output = '', db
  child.stderr.on('data', chunk => { output += chunk }); child.stdout.resume()
  async function request(method, route, token, body, expected = 200) {
    const response = await fetch('http://127.0.0.1:' + port + route, { method, signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) { try { await request('GET', '/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
    assert.ok(ready, output)
    const login = deviceId => request('POST', '/v1/auth/demo', '', { deviceId })
    const patient = await login('record-request-patient'), other = await login('record-request-other-user'), admin = await login('record-request-admin-user')
    await request('POST', '/v1/staff/claim', admin.token, { code: fs.readFileSync(path.join(directory, 'bootstrap-code.txt'), 'utf8').trim(), displayName: '资料管理员' })
    const desk = await login('record-request-frontdesk'), doctor = await login('record-request-doctor-user')
    for (const [account, role] of [[desk,'frontdesk'], [doctor,'doctor']]) {
      const invite = await request('POST', '/v1/staff/invites', admin.token, { role, ...(role === 'doctor' ? { doctorName: '李医生' } : {}) }, 201)
      await request('POST', '/v1/staff/claim', account.token, { code: invite.code, displayName: '资料测试员工' })
    }
    db = new DatabaseSync(database)
    const stamp = new Date().toISOString()
    db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,note,created_at,updated_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('record-visit','record-booking','测试患者','13800000000','洁牙护理','李医生','2026-10-05','10:00','已完成','测试','保留原始资料',stamp,stamp,patient.profile.id)
    db.prepare('INSERT INTO family_members VALUES (?,?,?,?,?,?,?,?,?)').run('shared-member', patient.profile.id, '测试患者', '本人', '13800000000', 1, 1, 'member-key', stamp)
    db.prepare('UPDATE appointments SET member_id=? WHERE id=?').run('shared-member', 'record-visit')
    db.prepare('INSERT INTO member_shares VALUES (?,?,?,?,?,?,?,?)').run('share-id', 'shared-member', patient.profile.id, other.profile.id, '只读家人', 1, 'share-hash', stamp)
    assert.equal((await request('GET', '/v1/appointments/record-visit/history', other.token)).history.appointment.mayManage, false)
    const body = { appointmentId: 'record-visit', kind: 'correction', details: '更正就诊小结中的错字', requestKey: 'record-key' }
    await request('GET', '/v1/record-requests', '', undefined, 401)
    await request('POST', '/v1/record-requests', other.token, body, 403)
    await request('POST', '/v1/record-requests', patient.token, null, 400)
    await request('POST', '/v1/record-requests', patient.token, { ...body, details: ' ' }, 400)
    await request('POST', '/v1/record-requests', patient.token, { ...body, details: '字'.repeat(2001) }, 400)
    const submitted = (await request('POST', '/v1/record-requests', patient.token, body, 201)).request
    assert.equal(submitted.status, 'submitted'); assert.equal(submitted.events.length, 1)
    assert.equal((await request('POST', '/v1/record-requests', patient.token, body, 201)).request.id, submitted.id)
    await request('POST', '/v1/record-requests', patient.token, { ...body, details: '其他内容' }, 409)
    await request('POST', '/v1/record-requests', patient.token, { ...body, requestKey: 'second-key' }, 409)
    for (const account of [other, desk, doctor]) {
      assert.equal((await request('GET', '/v1/record-requests', account.token)).total, 0)
      await request('GET', '/v1/record-requests?scope=clinic', account.token, undefined, 403)
      await request('PATCH', '/v1/record-requests/' + submitted.id, account.token, { status: 'processing', version: 1, note: '受理' }, 403)
    }
    assert.equal((await request('GET', '/v1/record-requests?scope=clinic', admin.token)).total, 1)
    const route = '/v1/record-requests/' + submitted.id
    db.exec("CREATE TRIGGER fail_request_audit BEFORE INSERT ON record_request_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    await request('PATCH', route, admin.token, { status: 'processing', version: 1, note: '失败受理' }, 500)
    assert.equal(db.prepare('SELECT version FROM record_requests WHERE id=?').get(submitted.id).version, 1)
    db.exec('DROP TRIGGER fail_request_audit')
    await request('PATCH', route, admin.token, { status: 'completed', version: 1, note: '跳过受理', confirmed: true }, 409)
    const processing = (await request('PATCH', route, admin.token, { status: 'processing', version: 1, note: '已受理，核验身份与资料范围' })).request
    assert.equal(processing.version, 2)
    await request('PATCH', route, patient.token, { status: 'withdrawn', version: 2, note: '撤回' }, 409)
    await request('PATCH', route, admin.token, { status: 'rejected', version: 1, note: '过期版本' }, 409)
    await request('PATCH', route, admin.token, { status: 'completed', version: 2, note: '测试结果' }, 400)
    await request('PATCH', route, admin.token, { status: 'completed', version: 2, note: '', confirmed: true }, 400)
    const completed = (await request('PATCH', route, admin.token, { status: 'completed', version: 2, note: '已核实并更正小结', confirmed: true, correction: { version: 0, findings: '检查结果更正', treatment: '洁牙已完成', nextSteps: '定期复查' } })).request
    assert.equal(completed.events.length, 3); assert.equal(completed.status, 'completed')
    await request('PATCH', route, admin.token, { status: 'processing', version: 3, note: '重新开启' }, 409)
    const deletion = (await request('POST', '/v1/record-requests', patient.token, { ...body, kind: 'deletion', requestKey: 'delete-key' }, 201)).request
    const deletionRoute = '/v1/record-requests/' + deletion.id
    await request('PATCH', deletionRoute, other.token, { status: 'withdrawn', version: 1, note: '越权' }, 403)
    await request('PATCH', deletionRoute, admin.token, { status: 'processing', version: 1, note: '核验删除范围' })
    await request('PATCH', deletionRoute, admin.token, { status: 'rejected', version: 2, note: '当前不能办理，保留原记录；请联系诊所进一步核实范围' })
    const withdrawn = (await request('POST', '/v1/record-requests', patient.token, { ...body, requestKey: 'withdraw-key' }, 201)).request
    await request('PATCH', '/v1/record-requests/' + withdrawn.id, patient.token, { status: 'withdrawn', version: 1, note: '内容待补充' })
    assert.equal((await request('GET', '/v1/record-requests?status=completed', patient.token)).total, 1)
    await request('GET', '/v1/record-requests?page=0', patient.token, undefined, 400)
    await request('GET', '/v1/record-requests?status=bad', patient.token, undefined, 400)
    assert.equal(db.prepare('SELECT note FROM appointments WHERE id=?').get('record-visit').note, '保留原始资料')
    for (let index = 0; index < 21; index++) {
      const item = (await request('POST', '/v1/record-requests', patient.token, { ...body, requestKey: 'page-' + index }, 201)).request
      await request('PATCH', '/v1/record-requests/' + item.id, patient.token, { status: 'withdrawn', version: 1, note: '分页测试' })
    }
    const first = await request('GET', '/v1/record-requests', patient.token), second = await request('GET', '/v1/record-requests?page=2', patient.token)
    assert.equal(first.items.length, 20); assert.equal(first.hasMore, true); assert.equal(second.items.length, 4)
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 24)
    db.close(); db = new DatabaseSync(database)
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM record_requests').get().total, 24)
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM record_request_events WHERE request_id=?').get(submitted.id).total, 3)
    console.log('PASS: record requests authentication, ownership, roles, validation, idempotency, transitions, audit, pagination and persistence')
  } finally {
    if (db) db.close()
    const exited = once(child, 'exit'); child.kill(); await exited
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('apex-record-requests-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
