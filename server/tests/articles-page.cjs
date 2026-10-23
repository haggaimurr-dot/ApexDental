const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const api = require('../../miniprogram/lib/api')
const mixin = require('../../miniprogram/lib/articles-page')
let definition
global.Page = value => { definition = value }
global.wx = { showToast() {} }
require('../../miniprogram/pages/index/index')
const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8')
for (const match of wxml.matchAll(/(?:bind|catch)(?:tap|input|change|confirm)="([^"]+)"/g)) {
  const names = match[1].startsWith('{{') ? [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]) : [match[1]]
  for (const name of names) assert.equal(typeof definition[name], 'function', `Missing WXML event: ${name}`)
}
function page() {
  const result = { ...mixin, data: { ...structuredClone(definition.data), authReady: true, profile: { id: 'patient' } },
    setData(values) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value } }, showError() {} }
  result.clearArticles(); return result
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function main() {
  const p = page(), old = deferred(), fresh = deferred()
  let calls = 0
  api.articles = () => (++calls === 1 ? old.promise : fresh.promise)
  p.data.page = 'articles'
  const first = p.loadArticles(); p.articleQueryInput({ detail: { value: '新搜索' } }); const second = p.loadArticles()
  const row = { id: 'new', title: '新文章', status: 'published', updatedAt: '2026-10-01T02:00:00Z' }
  fresh.resolve({ items: [row], categories: [], total: 1, page: 1, hasMore: false }); await second
  old.resolve({ items: [{ ...row, id: 'old' }], categories: [], total: 1, page: 1, hasMore: false }); await first
  assert.equal(p.data.articleItems[0].id, 'new')
  const pending = deferred(); api.article = () => pending.promise
  const detail = p.openArticle({ currentTarget: { dataset: { id: 'new' } } }); p.clearArticles(); p.data.tab = 'clinic'; p.data.page = 'home'
  pending.resolve({ article: row }); await detail
  assert.equal(p.data.selectedArticle, null); assert.equal(p.data.articleLoading, false)
  p.data.tab = 'patient'; p.data.page = 'article-detail'; p.articleDetailId = 'new'
  let bookings = 0
  p.startBooking = () => { bookings++ }; p.loadCatalog = () => Promise.resolve()
  api.article = () => Promise.resolve({ article: { ...row, service: '测试服务', serviceAvailable: false } })
  await p.bookArticleService(); assert.equal(bookings, 0)
  api.article = () => Promise.reject(new Error('文章已下架'))
  await p.bookArticleService(); assert.equal(bookings, 0); assert.equal(p.data.selectedArticle, null)
  api.article = () => Promise.resolve({ article: { ...row, service: '测试服务', serviceAvailable: true } })
  await p.bookArticleService(); assert.equal(bookings, 1)
  const symptomPage = page(), requests = []
  api.articles = (...args) => { requests.push(args); return Promise.resolve({ items: [row], categories: [], total: 21, page: args[2], hasMore: args[2] === 1 }) }
  symptomPage.data.articleQuery = '旧关键词'; symptomPage.data.articleCategory = '旧分类'
  await symptomPage.showSymptomArticles({ currentTarget: { dataset: { id: 'bleeding' } } })
  assert.equal(symptomPage.data.page, 'articles'); assert.equal(symptomPage.data.articleSymptomName, '牙龈出血')
  assert.deepEqual(requests[0], ['', '', 1, false, 'bleeding', '', '', ''])
  await symptomPage.moreArticles(); assert.equal(requests[1][2], 2); assert.equal(requests[1][4], 'bleeding')
  await symptomPage.articleSymptomChange({ currentTarget: { dataset: { id: '' } } })
  assert.equal(requests[2][2], 1); assert.equal(requests[2][4], '')
  symptomPage.data.articleEditor = { symptoms: [] }
  const tagEvent = { currentTarget: { dataset: { id: 'bleeding' } } }
  symptomPage.articleEditorSymptom(tagEvent); assert.deepEqual(symptomPage.data.articleEditor.symptoms, ['bleeding'])
  symptomPage.data.articleSaving = true; symptomPage.articleEditorSymptom(tagEvent); assert.deepEqual(symptomPage.data.articleEditor.symptoms, ['bleeding'])
  symptomPage.data.articleSaving = false; symptomPage.articleEditorSymptom(tagEvent); assert.deepEqual(symptomPage.data.articleEditor.symptoms, [])
  const delayed = deferred(), latest = deferred(); let symptomCalls = 0
  api.articles = () => (++symptomCalls === 1 ? delayed.promise : latest.promise)
  const staleSymptom = symptomPage.showSymptomArticles(tagEvent)
  const nextSymptom = symptomPage.articleSymptomChange({ currentTarget: { dataset: { id: 'toothache' } } })
  latest.resolve({ items: [row], categories: [], total: 1, page: 1, hasMore: false }); await nextSymptom
  delayed.resolve({ items: [{ ...row, id: 'stale' }], categories: [], total: 1, page: 1, hasMore: false }); await staleSymptom
  assert.equal(symptomPage.data.articleItems[0].id, 'new'); assert.equal(symptomPage.data.articleSymptom, 'toothache')
  symptomPage.clearArticles(); assert.equal(symptomPage.data.articleSymptom, '')
  console.log('PASS: WXML event bindings, stale search/detail responses, account/tab reset, booking publication and service checks')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
