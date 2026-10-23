const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { createArticles } = require('../articles')
const { createCatalog } = require('../catalog')
async function main() {
  const legacy = new DatabaseSync(':memory:')
  try {
    legacy.exec("CREATE TABLE articles (id TEXT PRIMARY KEY,title TEXT NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL,category_id TEXT NOT NULL,service TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,published_at TEXT,updated_at TEXT NOT NULL); INSERT INTO articles VALUES ('legacy','旧文章','','保留正文','daily-care','','published',7,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')")
    const migrated = createArticles(legacy, { names: () => [] })
    const detail = migrated.detail({}, 'legacy')
    assert.equal(detail.body, '保留正文'); assert.equal(detail.version, 7)
    assert.deepEqual(detail.populations, []); assert.deepEqual(detail.doctorNames, [])
    createArticles(legacy, { names: () => [] }); assert.equal(migrated.list({}, new URLSearchParams()).total, 1)
  } finally { legacy.close() }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-content-review-'))
  const port = 21000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`
  const dbPath = path.join(directory, 'check.sqlite')
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APEX_DEMO_AUTH: '1', APEX_PORT: String(port), APEX_DATA_DIR: directory, APEX_DB_PATH: dbPath } })
  let output = ''; child.stderr.on('data', chunk => { output += chunk }); child.stdout.resume()
  async function request(method, route, token, body, expected = 200) {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(4000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`); return result
  }
  try {
    let ready = false
    for (let i = 0; i < 40; i++) { try { await request('GET', '/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
    assert.ok(ready, output)
    const admin = (await request('POST', '/v1/auth/demo', '', { deviceId: 'content-admin-device-001' })).token
    const patient = (await request('POST', '/v1/auth/demo', '', { deviceId: 'content-patient-device-001' })).token
    await request('POST', '/v1/staff/claim', admin, { code: fs.readFileSync(path.join(directory, 'bootstrap-code.txt'), 'utf8').trim(), displayName: '内容管理员' })
    const tokens = {}
    for (const role of ['doctor', 'frontdesk']) {
      const token = (await request('POST', '/v1/auth/demo', '', { deviceId: `content-${role}-device-001` })).token
      const invite = await request('POST', '/v1/staff/invites', admin, { role, doctorName: role === 'doctor' ? '李医生' : '' }, 201)
      await request('POST', '/v1/staff/claim', token, { code: invite.code, displayName: role }); tokens[role] = token
      await request('GET', '/v1/admin/articles', token, undefined, 403)
    }
    const reviewer = tokens.doctor
    await request('GET', '/v1/articles', '', undefined, 401)
    for (const token of [patient, tokens.frontdesk]) {
      await request('GET', '/v1/content-reviews', token, undefined, 403)
      await request('POST', '/v1/content-reviews/missing', token, { decision: 'approve' }, 403)
    }
    assert.equal((await request('GET', '/v1/admin/articles', admin)).total, 2)
    assert.equal((await request('GET', '/v1/articles', patient)).total, 0)
    const category = (await request('POST', '/v1/admin/article-categories', admin, { name: '审核测试' })).category
    await request('POST', '/v1/admin/article-categories', admin, { name: category.name }, 409)
    const data = { title: '测试正文', summary: '测试摘要', body: '第一段\n第二段（功能验证）', categoryId: category.id, service: '洁牙护理', symptoms: ['bleeding'], populations: ['adults'], doctorNames: ['李医生'] }
    let article = (await request('POST', '/v1/admin/articles', admin, data, 201)).article
    const route = `/v1/admin/articles/${article.id}`, reviewRoute = `/v1/content-reviews/${article.id}`
    for (const invalid of [{ populations: ['unknown'] }, { doctorNames: ['missing'] }, { symptoms: ['bleeding', 'bleeding'] }]) await request('PUT', route, admin, { ...article, ...invalid }, 400)
    await request('POST', route + '/status', admin, { version: article.version, status: 'published' }, 400)
    article = (await request('POST', reviewRoute, admin, { version: article.version, decision: 'submit' })).article
    assert.equal(article.status, 'pending')
    await request('GET', `/v1/articles/${article.id}`, patient, undefined, 404)
    await request('GET', reviewRoute, patient, undefined, 403)
    await request('PUT', route, admin, article, 409)
    await request('POST', reviewRoute, admin, { version: article.version, decision: 'approve', note: '本人审核' }, 403)
    await request('POST', reviewRoute, reviewer, { version: article.version, decision: 'approve', note: '' }, 400)
    await request('POST', reviewRoute, reviewer, { version: article.version - 1, decision: 'approve', note: '旧版' }, 409)
    assert.equal((await request('GET', '/v1/content-reviews', reviewer)).total, 1)
    article = (await request('POST', reviewRoute, reviewer, { version: article.version, decision: 'reject', note: '补齐说明' })).article
    assert.equal((await request('GET', route, admin)).article.reviewNote, '补齐说明')
    article = (await request('PUT', route, admin, { ...article, body: '修订正文\n'.repeat(3500) })).article
    assert.equal(article.status, 'draft')
    // Older clients preserve tags and relations when omitted.
    const oldClient = { ...article }; delete oldClient.populations; delete oldClient.doctorNames; delete oldClient.symptoms
    article = (await request('PUT', route, admin, oldClient)).article
    assert.deepEqual(article.populations, ['adults']); assert.deepEqual(article.doctorNames, ['李医生'])
    async function publish(entry) {
      entry = (await request('POST', `/v1/content-reviews/${entry.id}`, admin, { version: entry.version, decision: 'submit' })).article
      entry = (await request('POST', `/v1/content-reviews/${entry.id}`, reviewer, { version: entry.version, decision: 'approve', note: '仅功能验证通过' })).article
      await request('GET', `/v1/articles/${entry.id}`, patient, undefined, 404)
      return (await request('POST', `/v1/admin/articles/${entry.id}/status`, admin, { version: entry.version, status: 'published' })).article
    }
    article = await publish(article)
    const publicDetail = (await request('GET', `/v1/articles/${article.id}`, patient)).article
    assert.equal(publicDetail.editorId, undefined); assert.equal(publicDetail.history, undefined)
    assert.equal(publicDetail.doctors[0].name, '李医生')
    assert.equal((await request('GET', '/v1/articles?population=adults&doctor=' + encodeURIComponent('李医生') + '&service=' + encodeURIComponent('洁牙护理') + '&symptom=bleeding&q=' + encodeURIComponent('修订'), patient)).total, 1)
    assert.equal((await request('GET', '/v1/articles?population=children', patient)).total, 0)
    await request('GET', '/v1/articles?population=invalid', patient, undefined, 400)
    await request('GET', '/v1/content-reviews?page=0', reviewer, undefined, 400)
    const catalog = await request('GET', '/v1/admin/catalog', admin)
    const doctor = catalog.doctors.find(row => row.name === '李医生'), service = catalog.services.find(row => row.name === '洁牙护理')
    await request('PUT', `/v1/admin/catalog/doctors/${doctor.id}`, admin, { ...doctor, enabled: false })
    await request('PUT', `/v1/admin/catalog/services/${service.id}`, admin, { ...service, enabled: false })
    const disabled = (await request('GET', `/v1/articles/${article.id}`, patient)).article
    assert.deepEqual(disabled.doctors, []); assert.equal(disabled.serviceAvailable, false)
    // Published edits become hidden drafts and invalidate previous approval.
    article = (await request('PUT', route, admin, { ...article, summary: '更正摘要' })).article
    assert.equal(article.status, 'draft')
    await request('GET', `/v1/articles/${article.id}`, patient, undefined, 404)
    await request('POST', route + '/status', admin, { version: article.version, status: 'published' }, 400)
    article = await publish(article)
    article = (await request('POST', route + '/status', admin, { version: article.version, status: 'offline' })).article
    await request('GET', `/v1/articles/${article.id}`, patient, undefined, 404)
    article = await publish(article)
    let pending = (await request('POST', '/v1/admin/articles', admin, data, 201)).article
    pending = (await request('POST', `/v1/content-reviews/${pending.id}`, admin, { version: pending.version, decision: 'submit' })).article
    pending = (await request('POST', `/v1/content-reviews/${pending.id}`, admin, { version: pending.version, decision: 'withdraw' })).article
    assert.equal(pending.status, 'draft')
    for (let i = 0; i < 21; i++) {
      const draft = (await request('POST', '/v1/admin/articles', admin, { ...data, title: `分页 ${i}` }, 201)).article
      await publish(draft)
    }
    const first = await request('GET', '/v1/articles?population=adults', patient), second = await request('GET', '/v1/articles?population=adults&page=2', patient)
    assert.equal(first.total, 22); assert.equal(first.items.length, 20); assert.equal(second.items.length, 2)
    assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 22)
    const stored = new DatabaseSync(dbPath)
    try {
      const module = createArticles(stored, createCatalog(stored)), user = { id: 'test', role: 'admin', isStaff: true }
      assert.equal(module.detail(user, article.id, true).version, article.version)
      assert.ok(module.detail(user, article.id, true).history.length >= 10)
      // Audit failure rolls back approval, status and version together.
      stored.exec("CREATE TRIGGER fail_review BEFORE INSERT ON article_events WHEN NEW.kind='review-approve' BEGIN SELECT RAISE(ABORT,'audit failed'); END")
      const submitted = module.review(user, pending.id, { version: pending.version, decision: 'submit' })
      assert.throws(() => module.review({ id: 'other', role: 'doctor', isStaff: true }, pending.id, { version: submitted.version, decision: 'approve', note: '通过' }), /audit failed/)
      assert.equal(module.detail(user, pending.id, true).status, 'pending'); assert.equal(module.detail(user, pending.id, true).version, submitted.version)
    } finally { stored.close() }
    console.log('PASS: independent review permissions, self-review prevention, reject/withdraw, publication gating, edit invalidation, audit rollback, populations/doctor/service filters, pagination, migration and persistence')
  } finally { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }; fs.rmSync(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
