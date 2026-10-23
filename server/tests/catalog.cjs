const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const todayKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-catalog-check-'))
  const port = 21000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APEX_DEMO_AUTH: '1', APEX_PORT: String(port), APEX_DATA_DIR: directory, APEX_DB_PATH: path.join(directory, 'check.sqlite') }
  })
  let output = ''; child.stderr.on('data', chunk => { output += chunk }); child.stdout.resume()
  async function request(method, route, token, body, status = 200) {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(result)}`)
    return result
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await request('GET', '/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    assert.ok(ready, output)
    const admin = (await request('POST', '/v1/auth/demo', '', { deviceId: 'catalog-admin-device' })).token
    const patient = (await request('POST', '/v1/auth/demo', '', { deviceId: 'catalog-patient-device' })).token
    await request('POST', '/v1/staff/claim', admin, { code: fs.readFileSync(path.join(directory, 'bootstrap-code.txt'), 'utf8').trim(), displayName: '资料管理员' })
    await request('GET', '/v1/admin/catalog', patient, undefined, 403)
    await request('POST', '/v1/admin/catalog/services', patient, {}, 403)
    const clinic = (await request('GET', '/v1/admin/catalog', admin)).clinic
    const savedClinic = (await request('PUT', '/v1/admin/catalog/clinic', admin, { ...clinic, address: '虚构测试路 1 号', phone: '010-12345678', hours: '周一至周五 09:00–18:00' })).entry
    assert.equal(savedClinic.version, clinic.version + 1)
    await request('PUT', '/v1/admin/catalog/clinic', admin, clinic, 409)
    const service = (await request('POST', '/v1/admin/catalog/services', admin, { name: '测试新服务', introduction: '测试说明', preparation: '测试准备', durationMinutes: 45, enabled: true })).entry
    const doctor = (await request('POST', '/v1/admin/catalog/doctors', admin, { name: '测试医生', title: '测试职称', license: '测试执业信息', specialties: '测试擅长', introduction: '测试简介', serviceNames: [service.name], enabled: true })).entry
    const publicCatalog = await request('GET', '/v1/catalog', patient)
    assert.equal(publicCatalog.clinic.address, savedClinic.address)
    assert.ok(publicCatalog.doctors.some(row => row.id === doctor.id))
    await request('POST', '/v1/admin/catalog/services', admin, service, 409)
    await request('PUT', `/v1/admin/catalog/doctors/${doctor.id}`, admin, { ...doctor, serviceNames: ['不存在的项目'] }, 400)
    await request('PUT', `/v1/admin/catalog/doctors/${doctor.id}`, admin, { ...doctor, name: '改名' }, 409)
    const invite = await request('POST', '/v1/staff/invites', admin, { role: 'doctor', doctorName: doctor.name }, 201)
    const date = new Date(`${todayKey()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)
    const key = date.toISOString().slice(0, 10)
    const schedule = { doctor: doctor.name, date: key, start: '09:00', end: '10:00', capacity: 2, enabled: true, version: 0 }
    await request('PUT', '/v1/admin/schedules', admin, schedule)
    const availabilityRoute = `/v1/availability?date=${key}&doctor=${encodeURIComponent(doctor.name)}`
    assert.equal((await request('GET', availabilityRoute + `&service=${encodeURIComponent(service.name)}`)).slots[0].remaining, 2)
    assert.equal((await request('GET', availabilityRoute + '&service=' + encodeURIComponent('洁牙护理'))).slots.length, 0)
    const booking = { name: '测试患者', phone: '13800000000', doctor: doctor.name, service: service.name, date: key, slot: '09:00', requestKey: 'catalog-booking' }
    const appointment = (await request('POST', '/v1/appointments', patient, booking, 201)).appointment
    await request('PUT', `/v1/admin/catalog/doctors/${doctor.id}`, admin, { ...doctor, enabled: false })
    assert.equal((await request('GET', availabilityRoute)).slots.length, 0)
    assert.ok(!(await request('GET', '/v1/catalog', patient)).doctors.some(row => row.id === doctor.id))
    assert.ok((await request('GET', '/v1/catalog', patient)).doctorNames.includes(doctor.name))
    await request('POST', '/v1/appointments', patient, { ...booking, requestKey: 'disabled-doctor-booking', slot: '09:30' }, 409)
    await request('POST', '/v1/staff/invites', admin, { role: 'doctor', doctorName: doctor.name }, 400)
    await request('POST', '/v1/staff/claim', patient, { code: invite.code, displayName: '测试医生员工' }, 409)
    await request('POST', `/v1/appointments/${appointment.id}/reschedule`, patient, { scope: 'mine', date: key, slot: '09:30', version: appointment.version, reason: '测试改期', requestKey: 'catalog-reschedule' }, 409)
    assert.ok((await request('GET', '/v1/appointments?scope=mine', patient)).appointments.some(row => row.id === appointment.id))
    await request('PATCH', `/v1/appointments/${appointment.id}/status`, admin, { status: '已预约', version: appointment.version,communicationNote: '已与患者核对保留既有预约' })
    const enabledDoctor = (await request('PUT', `/v1/admin/catalog/doctors/${doctor.id}`, admin, { ...doctor, version: doctor.version + 1, enabled: true })).entry
    assert.equal(enabledDoctor.version, 3)
    await request('PUT', `/v1/admin/catalog/services/${service.id}`, admin, { ...service, enabled: false })
    await request('POST', '/v1/appointments', patient, { ...booking, requestKey: 'disabled-service-booking', slot: '09:30' }, 409)
    assert.equal((await request('GET', availabilityRoute + `&service=${encodeURIComponent(service.name)}`)).slots.length, 0)
    const { DatabaseSync } = require('node:sqlite')
    const persisted = new DatabaseSync(path.join(directory, 'check.sqlite'))
    try {
      const catalog = require('../catalog').createCatalog(persisted)
      assert.ok(!catalog.names('services').includes(service.name))
      assert.equal(catalog.list({ role: 'admin', isStaff: true }, true).clinic.address, savedClinic.address)
      assert.equal(catalog.list({ role: 'admin', isStaff: true }, true).doctors.find(row => row.id === doctor.id).version, 3)
    } finally { persisted.close() }
    console.log('PASS: catalog persistence, administrator access, version conflicts, dynamic doctor/service booking, service scope, disabled booking/rescheduling/invites, historical records')
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    const target = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep
    assert.ok(target.startsWith(temporaryRoot) && path.basename(target).startsWith('apex-catalog-check-'))
    fs.rmSync(target, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
