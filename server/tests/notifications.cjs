const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createNotifications } = require('../notifications')

function fixture(options = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,subject TEXT);
    CREATE TABLE appointments(id TEXT PRIMARY KEY,owner_id TEXT,patient TEXT,doctor TEXT,service TEXT,date TEXT,slot TEXT,status TEXT,recall_id TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,appointment_id TEXT,to_status TEXT);
    CREATE TABLE care_tasks(id TEXT PRIMARY KEY,appointment_id TEXT,due_date TEXT,status TEXT);
    CREATE TABLE recall_plans(appointment_id TEXT PRIMARY KEY,due_date TEXT,version INTEGER);
    INSERT INTO users VALUES ('p','wx:patient-openid'),('other','wx:other-openid');
    INSERT INTO appointments VALUES ('a','p','测试患者','李医生','洁牙护理','2026-10-02','10:00','已预约','');`)
  let clock = Date.parse('2026-10-01T02:00:00Z'), calls = [], reply = { errcode: 0 }, interrupted = false, callback
  const env = { APEX_WECHAT_APPID: 'wx0123456789abcdef', APEX_WECHAT_SECRET: 'test-secret', APEX_WECHAT_TEMPLATES: JSON.stringify(Object.fromEntries(['confirmation','visit_day','visit_soon','care','recall'].map(kind => [kind, { id: `template-${kind}`, fields: { thing1: 'title', time2: 'time' } }]))) }
  const fetcher = async (url, args) => {
    if (url.includes('/token?')) return { ok: true, json: async () => ({ access_token: 'fake-token', expires_in: 7200 }) }
    calls.push(JSON.parse(args.body)); if (callback) await callback()
    if (interrupted) throw new Error('timeout')
    return { ok: true, json: async () => reply }
  }
  const service = createNotifications(db, { env: options.unconfigured ? {} : env, fetcher, now: () => clock })
  const patient = { id: 'p', role: 'patient' }, other = { id: 'other', role: 'patient' }, admin = { id: 'admin', role: 'admin' }
  const params = new URLSearchParams()
  function accept() { service.subscribe(patient, { choices: ['confirmation','visit_day','visit_soon'].map(kind => ({ templateId: `template-${kind}`, choice: 'accept' })) }); service.subscribe(patient, { choices: ['care','recall'].map(kind => ({ templateId: `template-${kind}`, choice: 'accept' })) }) }
  return { db, service, patient, other, admin, params, calls, accept,
    time: value => { clock = Date.parse(value) }, response: value => { reply = value }, timeout: () => { interrupted = true }, callback: value => { callback = value } }
}

async function main() {
  let f = fixture({ unconfigured: true })
  await f.service.tick()
  let messages = f.service.list(f.patient, f.params)
  assert.equal(messages.total, 1); assert.equal(messages.items[0].kind, 'visit_day'); assert.equal(messages.items[0].status, 'blocked')
  assert.equal(f.calls.length, 0); assert.equal(f.service.list(f.other, f.params).total, 0)
  const id = messages.items[0].id
  assert.throws(() => f.service.read(f.other, id), { status: 404 })
  assert.throws(() => f.service.list(f.patient, f.params, true), { status: 403 })
  assert.throws(() => f.service.retry(f.patient, id), { status: 403 })
  f.service.read(f.patient, id); f.service.read(f.patient, id); assert.equal(f.service.list(f.patient, f.params).unread, 0)
  assert.equal(createNotifications(f.db, { env: {}, now: () => Date.parse('2026-10-01T02:00:00Z') }).list(f.patient, f.params).total, 1)
  f.db.close()

  f = fixture(); f.accept()
  f.db.prepare("INSERT INTO events VALUES (1,'a','已预约')").run()
  await Promise.all([f.service.tick(), f.service.tick()])
  assert.equal(f.calls.length, 2); assert.equal(f.service.list(f.patient, f.params).total, 2)
  assert.equal(f.calls[0].touser, 'patient-openid'); assert.equal(f.calls[0].data.time2.value, '2026-10-02 10:00')
  await f.service.tick(); assert.equal(f.calls.length, 2)
  assert.ok(f.service.list(f.admin, f.params, true).items.every(m => m.status === 'sent' && m.history.length === 1))
  f.db.exec("UPDATE appointments SET date='2026-10-03' WHERE id='a'")
  assert.ok(f.service.list(f.patient, f.params).items.every(m => m.obsolete))
  assert.throws(() => f.service.retry(f.admin, f.service.list(f.patient, f.params).items[0].id), { status: 409 })
  f.db.close()

  f = fixture(); f.accept(); f.response({ errcode: -1 })
  await f.service.tick(); assert.equal(f.calls.length, 1)
  assert.equal(f.service.list(f.patient, f.params).items[0].status, 'retry')
  await f.service.tick(); assert.equal(f.calls.length, 1)
  f.time('2026-10-01T02:03:00Z'); await f.service.tick(); assert.equal(f.calls.length, 2)
  f.time('2026-10-01T02:10:00Z'); await f.service.tick()
  const failed = f.service.list(f.admin, f.params, true).items[0]
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 3); assert.equal(failed.history.length, 3)
  f.service.retry(f.admin, failed.id); f.response({ errcode: 0 }); await f.service.tick()
  assert.equal(f.service.list(f.patient, f.params).items[0].status, 'sent'); assert.equal(f.calls.length, 4)
  f.db.close()

  f = fixture(); f.accept(); f.timeout(); await f.service.tick()
  assert.equal(f.service.list(f.patient, f.params).items[0].status, 'uncertain')
  f.time('2026-10-01T03:00:00Z'); await f.service.tick(); assert.equal(f.calls.length, 1)
  f.db.close()

  f = fixture(); f.accept(); f.response({ errcode: 43101 }); await f.service.tick()
  assert.equal(f.service.list(f.patient, f.params).items[0].status, 'blocked')
  await f.service.tick(); assert.equal(f.calls.length, 1)
  f.accept(); f.response({ errcode: 0 }); await f.service.tick(); assert.equal(f.calls.length, 2)
  f.db.close()

  f = fixture(); f.accept()
  f.db.exec("UPDATE appointments SET date='2026-10-01',slot='11:00'; INSERT INTO care_tasks VALUES ('c','a','2026-10-01','published'); INSERT INTO recall_plans VALUES ('a','2026-10-01',1)")
  await f.service.tick()
  assert.deepEqual(new Set(f.service.list(f.patient, f.params).items.map(m => m.kind)), new Set(['visit_soon','care','recall']))
  assert.equal(f.calls.length, 3)
  f.db.exec("UPDATE care_tasks SET status='waiting_review'; INSERT INTO appointments VALUES ('b','p','测试','李医生','洁牙护理','2026-10-03','10:00','待确认','a')")
  assert.ok(f.service.list(f.patient, f.params).items.filter(m => ['care','recall'].includes(m.kind)).every(m => m.obsolete))
  f.db.exec("UPDATE recall_plans SET version=2; UPDATE appointments SET status='已取消' WHERE id='b'")
  await f.service.tick(); assert.equal(f.service.list(f.patient, f.params).items.filter(m => m.kind === 'recall').length, 2)
  f.db.close()

  f = fixture(); f.accept(); f.time('2026-10-01T00:59:00Z')
  f.db.exec("UPDATE appointments SET date='2026-10-04'; INSERT INTO care_tasks VALUES ('c','a','2026-10-01','published'); INSERT INTO recall_plans VALUES ('a','2026-10-01',1)")
  await f.service.tick(); assert.equal(f.calls.length, 0)
  f.time('2026-10-01T01:00:00Z'); await f.service.tick(); assert.equal(f.calls.length, 2)
  f.time('2026-10-02T01:00:00Z'); await f.service.tick(); assert.equal(f.calls.length, 2)
  f.db.close()

  f = fixture(); f.accept()
  f.db.exec("INSERT INTO events VALUES (1,'a','已预约'),(2,'a','待确认'),(3,'a','已预约')")
  await f.service.tick(); assert.equal(f.calls.filter(m => m.template_id === 'template-confirmation').length, 1)
  f.db.close()

  f = fixture(); f.service.scan()
  f.db.exec("UPDATE notification_messages SET status='sending',lease_until='2026-10-01T01:00:00Z',attempts=1")
  await f.service.tick(); assert.equal(f.service.list(f.patient, f.params).items[0].status, 'uncertain'); assert.equal(f.calls.length, 0)
  f.db.close()
  console.log('PASS: reminder timing, durable deduplication, access control, read receipts, consent, retries, ambiguous sends, stale care/recall/appointment suppression')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
