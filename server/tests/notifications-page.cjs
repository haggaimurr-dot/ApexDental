const assert = require('node:assert/strict')
const api = require('../../miniprogram/lib/api')
const mixin = require('../../miniprogram/lib/notifications-page')
let definition, subscribeCalls = 0, toast = 0
global.Page = value => { definition = value }
global.wx = { showToast: () => { toast++ }, requestSubscribeMessage: args => { subscribeCalls++; args.success({ [args.tmplIds[0]]: 'reject' }) } }
require('../../miniprogram/pages/index/index')
function page() {
  const p = { ...mixin, data: { ...structuredClone(definition.data), authReady: true, profile: { id: 'p', role: 'patient' } }, setData(values) { Object.assign(this.data, values) } }
  p.clearNotifications(); return p
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
async function main() {
  const p = page(), old = deferred()
  api.notifications = () => old.promise; api.notificationSettings = async () => ({ ready: true, templates: [] })
  const pending = p.showNotifications()
  p.clearNotifications(); p.data.profile = { id: 'other', role: 'patient' }; p.data.tab = 'clinic'; p.data.page = 'home'
  old.resolve({ items: [{ id: 'private' }], total: 1, unread: 1 }); await pending
  assert.equal(p.data.notificationItems.length, 0); assert.equal(p.data.notificationSettings, null)
  p.data.tab = 'patient'; p.data.page = 'notifications'; p.data.notificationSettings = { ready: true }
  let recorded
  api.subscribeNotifications = async choices => { recorded = choices; return { ready: true } }
  p.subscribeReminder({ currentTarget: { dataset: { id: 't' } } }); assert.equal(subscribeCalls, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(recorded, [{ templateId: 't', choice: 'reject' }]); assert.equal(p.data.notificationBusy, false); assert.equal(toast, 1)
  p.data.notificationSettings = { ready: false }; p.subscribeReminder({ currentTarget: { dataset: { id: 't' } } }); assert.equal(subscribeCalls, 1)
  let opened = false; p.showAppointments = () => { opened = true }; p.refreshRemote = async () => {}
  p.data.notificationItems = [{ id: 'stale', obsolete: true }, { id: 'live', kind: 'confirmation' }]
  p.openNotification({ currentTarget: { dataset: { id: 'stale' } } }); assert.equal(opened, false)
  p.data.memberFilter = 'family'; await p.openNotification({ currentTarget: { dataset: { id: 'live' } } }); assert.equal(opened, true); assert.equal(p.data.memberFilter, 'all')
  console.log('PASS: notification page identity reset, subscription rejection/unconfigured handling, obsolete navigation and member filter reset')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
