const { randomUUID } = require('node:crypto')
const { metadata } = require('./content-features')
const populations = require('../miniprogram/lib/article-populations')
const symptoms = require('../miniprogram/lib/article-symptoms')
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function createArticles(db, catalog) {
  db.exec(`CREATE TABLE IF NOT EXISTS article_categories (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY,title TEXT NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL,category_id TEXT NOT NULL REFERENCES article_categories(id),service TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,published_at TEXT,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS articles_listing ON articles(status,published_at,id);
    CREATE TABLE IF NOT EXISTS article_events (id INTEGER PRIMARY KEY,actor TEXT NOT NULL,entry_id TEXT NOT NULL,kind TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`)
  if (!db.prepare('PRAGMA table_info(articles)').all().some(column => column.name === 'symptoms_json')) db.exec("ALTER TABLE articles ADD COLUMN symptoms_json TEXT NOT NULL DEFAULT '[]'")
  for (const [name, definition] of Object.entries({ metadata_json: "TEXT NOT NULL DEFAULT '{}'", populations_json: "TEXT NOT NULL DEFAULT '[]'", doctors_json: "TEXT NOT NULL DEFAULT '[]'", editor_id: "TEXT NOT NULL DEFAULT ''", review_note: "TEXT NOT NULL DEFAULT ''", reviewer_id: "TEXT NOT NULL DEFAULT ''" })) {
    if (!db.prepare('PRAGMA table_info(articles)').all().some(column => column.name === name)) db.exec(`ALTER TABLE articles ADD COLUMN ${name} ${definition}`)
  }
  function reviewer(user) { if (!user.isStaff || !['admin', 'doctor'].includes(user.role)) fail(403, '仅医生或管理员可审核内容') }
  const seed = db.prepare('INSERT OR IGNORE INTO article_categories VALUES (?,?,1)')
  seed.run('daily-care', '日常护理'); seed.run('treatment', '治疗百科')
  const seedArticle = db.prepare("INSERT OR IGNORE INTO articles (id,title,summary,body,category_id,service,status,version,published_at,updated_at) VALUES (?,?,?,'',?,?, 'draft',1,NULL,?)")
  seedArticle.run('seed-bleeding', '刷牙时牙龈出血，平时该注意什么？', '', 'daily-care', '初次口腔检查', new Date().toISOString())
  seedArticle.run('seed-cleaning', '洗牙前后常见问题与护理建议', '', 'treatment', '洁牙护理', new Date().toISOString())
  function admin(user) { if (!user.isStaff || user.role !== 'admin') fail(403, '仅管理员可维护科普内容') }
  function text(body, field, max, required = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '内容格式无效')
    if (typeof body[field] !== 'string' || body[field].length > max || required && !body[field].trim()) fail(400, `请检查${({ title: '标题', summary: '摘要', body: '正文', name: '分类名称', note: '审核意见' })[field]}，最多 ${max} 字`)
    return body[field].trim()
  }
  function view(row, detail = false) {
    return { id: row.id, title: row.title, summary: row.summary, categoryId: row.category_id, categoryName: row.category_name,
      service: row.service, serviceAvailable: catalog.names('services').includes(row.service), symptoms: JSON.parse(row.symptoms_json), status: row.status, version: row.version,
      metadata: JSON.parse(row.metadata_json || '{}'), populations: JSON.parse(row.populations_json), doctorNames: JSON.parse(row.doctors_json),
      doctors: (catalog.entries ? catalog.entries('doctors') : []).filter(doctor => JSON.parse(row.doctors_json).includes(doctor.name)),
      media: db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_media'").get() ? db.prepare("SELECT id,mime,caption FROM content_media WHERE kind='article' AND target=? ORDER BY created_at,id").all(row.id) : [],
      publishedAt: row.published_at, updatedAt: row.updated_at, ...(detail ? { body: row.body } : {}) }
  }
  const select = 'SELECT a.*,c.name category_name FROM articles a JOIN article_categories c ON c.id=a.category_id'
  function categories(user, all = false) {
    if (all) admin(user)
    return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id=c.id ${all ? '' : "AND a.status='published'"}) count FROM article_categories c ORDER BY c.rowid`).all()
  }
  function detail(user, id, all = false) {
    if (all) admin(user)
    const row = db.prepare(`${select} WHERE a.id=? ${all ? '' : "AND a.status='published'"}`).get(id)
    if (!row) fail(404, '文章不存在或已下架')
    const result = view(row, true)
    if (all) Object.assign(result, { editorId: row.editor_id, reviewerId: row.reviewer_id, reviewNote: row.review_note, history: db.prepare('SELECT actor,kind,created_at FROM article_events WHERE entry_id=? ORDER BY id').all(id) })
    return result
  }
  function list(user, params, all = false) {
    if (all) admin(user)
    const q = params.get('q') || '', category = params.get('category') || '', symptom = params.get('symptom') || '', page = Number(params.get('page') || 1), population = params.get('population') || '', doctor = params.get('doctor') || '', service = params.get('service') || '', author = params.get('author') || '', kind = params.get('kind') || ''
    if (population && !populations.some(row => row.id === population)) fail(400, '请选择有效人群')
    if (doctor.length > 60 || service.length > 60) fail(400, '关联筛选无效')
    if (symptom && !symptoms.some(entry => entry.id === symptom)) fail(400, '请选择有效症状')
    if (q.length > 100 || category.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400, '搜索条件或页码无效')
    const where = [all ? '1=1' : "a.status='published'"], values = []
    if(kind){if(!['article','disease','service'].includes(kind))fail(400,'内容类型无效');where.push("COALESCE(json_extract(a.metadata_json,'$.kind'),'article')=?");values.push(kind)}
    if (author) { if(!all||author.length>100)fail(400,'署名筛选无效');where.push("json_extract(a.metadata_json,'$.authorId')=?");values.push(author) }
    if (population) { where.push('EXISTS (SELECT 1 FROM json_each(a.populations_json) WHERE value=?)'); values.push(population) }
    if (doctor) { where.push('EXISTS (SELECT 1 FROM json_each(a.doctors_json) WHERE value=?)'); values.push(doctor) }
    if (service) { where.push('a.service=?'); values.push(service) }
    if (category) { where.push('a.category_id=?'); values.push(category) }
    if (symptom) { where.push('EXISTS (SELECT 1 FROM json_each(a.symptoms_json) WHERE value=?)'); values.push(symptom) }
    if (q.trim()) { where.push('(instr(a.title,?)>0 OR instr(a.summary,?)>0 OR instr(a.body,?)>0)'); values.push(q.trim(), q.trim(), q.trim()) }
    const clause = where.join(' AND '), total = db.prepare(`SELECT COUNT(*) total FROM articles a WHERE ${clause}`).get(...values).total
    const rows = db.prepare(`${select} WHERE ${clause} ORDER BY COALESCE(json_extract(a.metadata_json,'$.featured'),0) DESC,COALESCE(a.published_at,a.updated_at) DESC,a.id DESC LIMIT 20 OFFSET ?`).all(...values, (page - 1) * 20)
    return { items: rows.map(row => view(row)), total, page, hasMore: page * 20 < total, categories: categories(user, all), populations }
  }
  function mutate(user, kind, operation, review = false) {
    if (review) reviewer(user); else admin(user); db.exec('BEGIN IMMEDIATE')
    try {
      const { before, after } = operation()
      db.prepare('INSERT INTO article_events (actor,entry_id,kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?)').run(user.id, after.id, kind, before ? JSON.stringify(before) : null, JSON.stringify(after), new Date().toISOString())
      db.exec('COMMIT'); return after
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function saveCategory(user, body, id) {
    return mutate(user, 'category', () => {
      const name = text(body, 'name', 40, true), before = id ? db.prepare('SELECT * FROM article_categories WHERE id=?').get(id) : null
      if (id && !before) fail(404, '分类不存在')
      if (before && before.version !== body.version) fail(409, '分类已修改，请重新加载后编辑')
      if (db.prepare('SELECT id FROM article_categories WHERE name=? AND id<>?').get(name, id || '')) fail(409, '分类名称已存在')
      const after = { id: id || randomUUID(), name, version: (before?.version || 0) + 1 }
      db.prepare('INSERT INTO article_categories VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version').run(after.id, name, after.version)
      return { before, after }
    })
  }
  function save(user, body, id) {
    return mutate(user, 'content', () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '内容格式无效')
      const before = id ? detail(user, id, true) : null
      if (before && before.version !== body.version) fail(409, '文章已被修改，请返回管理列表重新加载后编辑')
      const title = text(body, 'title', 100, true), summary = text(body, 'summary', 300), content = text(body, 'body', 20000, before?.status === 'published')
      if (typeof body.categoryId !== 'string' || !db.prepare('SELECT id FROM article_categories WHERE id=?').get(body.categoryId)) fail(400, '请选择有效分类')
      if (typeof body.service !== 'string' || body.service && !catalog.names('services', true).includes(body.service)) fail(400, '关联服务无效')
      const tags = body.symptoms === undefined ? before?.symptoms || [] : body.symptoms
      if (!Array.isArray(tags) || tags.length > symptoms.length || tags.some(tag => !symptoms.some(entry => entry.id === tag)) || new Set(tags).size !== tags.length) fail(400, '请选择有效且不重复的症状标签')
      const audiences = body.populations === undefined ? before?.populations || [] : body.populations
      const doctors = body.doctorNames === undefined ? before?.doctorNames || [] : body.doctorNames
      for (const [values, allowed, label] of [[audiences, populations.map(row => row.id), '人群'], [doctors, catalog.names('doctors', true), '关联医生']]) {
        if (!Array.isArray(values) || values.length > allowed.length || new Set(values).size !== values.length || values.some(value => !allowed.includes(value))) fail(400, `请选择有效且不重复的${label}`)
      }
      const meta = metadata(body.metadata === undefined ? before?.metadata || {} : body.metadata)
      if (meta.authorId && !db.prepare("SELECT 1 FROM staff WHERE user_id=? AND role='doctor' AND enabled=1").get(meta.authorId)) fail(400, '署名须选择在职医生账号')
      if (before?.status === 'pending') fail(409, '审核中的文章不能编辑，请先撤回审核')
      const entryId = id || randomUUID(), version = (before?.version || 0) + 1
      db.prepare(`INSERT INTO articles (id,title,summary,body,category_id,service,status,version,published_at,updated_at,symptoms_json) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,body=excluded.body,category_id=excluded.category_id,service=excluded.service,symptoms_json=excluded.symptoms_json,version=excluded.version,updated_at=excluded.updated_at`).run(entryId, title, summary, content, body.categoryId, body.service, before?.status || 'draft', version, before?.publishedAt || null, new Date().toISOString(), JSON.stringify(tags))
      db.prepare("UPDATE articles SET status='draft',populations_json=?,doctors_json=?,editor_id=?,reviewer_id='',review_note='' WHERE id=?").run(JSON.stringify(audiences), JSON.stringify(doctors), user.id, entryId)
      db.prepare('UPDATE articles SET metadata_json=? WHERE id=?').run(JSON.stringify(meta), entryId)
      return { before, after: detail(user, entryId, true) }
    })
  }
  function changeStatus(user, id, body) {
    return mutate(user, 'status', () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '发布状态格式无效')
      const before = detail(user, id, true)
      if (before.version !== body.version) fail(409, '文章已被修改，请重新加载后操作')
      if (!['published', 'offline'].includes(body.status) || body.status === before.status || body.status === 'offline' && before.status !== 'published') fail(400, '当前文章不能执行此操作')
      if (body.status === 'published' && before.status !== 'approved') fail(400, '请先提交独立审核并通过后再发布')
      if (body.status === 'published' && !before.body.trim()) fail(400, '请先填写并保存正文，再发布文章')
      db.prepare('UPDATE articles SET status=?,version=version+1,published_at=?,updated_at=? WHERE id=?').run(body.status, body.status === 'published' ? new Date().toISOString() : before.publishedAt, new Date().toISOString(), id)
      return { before, after: detail(user, id, true) }
    })
  }
  function reviewList(user, params) {
    reviewer(user)
    const status = params.get('status') || 'pending'
    if (!['pending', 'approved', 'rejected'].includes(status)) fail(400, '审核筛选无效')
    const page = Number(params.get('page') || 1)
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400, '页码无效')
    const total = db.prepare('SELECT COUNT(*) total FROM articles WHERE status=?').get(status).total
    return { items: db.prepare(`${select} WHERE a.status=? ORDER BY a.updated_at DESC,a.id LIMIT 20 OFFSET ?`).all(status, (page - 1) * 20).map(row => ({ ...view(row), editorId: row.editor_id })), total, page, hasMore: page * 20 < total }
  }
  function reviewDetail(user, id) {
    reviewer(user)
    const row = db.prepare(`${select} WHERE a.id=? AND a.status IN ('pending','approved','rejected')`).get(id)
    if (!row) fail(404, '审核内容不存在')
    return { ...view(row, true), editorId: row.editor_id, reviewerId: row.reviewer_id, reviewNote: row.review_note,
      history: db.prepare('SELECT actor,kind,created_at FROM article_events WHERE entry_id=? ORDER BY id').all(id) }
  }
  function review(user, id, body) {
    const decision = body?.decision, isDecision = ['approve', 'reject'].includes(decision)
    return mutate(user, 'review-' + decision, () => {
      if (!['submit', 'withdraw', 'approve', 'reject'].includes(decision)) fail(400, '审核操作无效')
      const row = db.prepare(`${select} WHERE a.id=?`).get(id)
      if (!row) fail(404, '文章不存在')
      if (row.version !== body.version) fail(409, '内容已变更，请重新加载')
      if(!isDecision && user.role==='doctor' && (JSON.parse(row.metadata_json).authorId!==user.id || row.editor_id!==user.id))fail(403,'仅可提交本人原创且最后由本人编辑的文章')
      if (isDecision && row.editor_id === user.id) fail(403, '不能审核本人最后编辑的内容')
      const note = isDecision ? text(body, 'note', 1000, true) : ''
      if (isDecision || decision === 'withdraw') { if (row.status !== 'pending') fail(409, '当前内容不在待审核状态') }
      else if (!['draft', 'rejected', 'offline'].includes(row.status) || !row.body.trim()) fail(400, '请先保存非空正文再提交审核')
      const status = { submit: 'pending', withdraw: 'draft', approve: 'approved', reject: 'rejected' }[decision]
      db.prepare('UPDATE articles SET status=?,version=version+1,review_note=?,reviewer_id=?,updated_at=? WHERE id=?').run(status, note, isDecision ? user.id : '', new Date().toISOString(), id)
      return { before: view(row, true), after: { ...view(db.prepare(`${select} WHERE a.id=?`).get(id), true), reviewNote: note } }
    }, isDecision || user.role==='doctor')
  }
  function ownAuthor(user){if(!user.isStaff||user.role!=='doctor')fail(403,'仅医生可维护本人原创');return {...user,role:'admin'}}
  function doctorDetail(user,id){const row=detail(ownAuthor(user),id,true);if(row.metadata.authorId!==user.id)fail(403,'仅可维护本人原创文章');return row}
  function doctorList(user,params){const delegated=ownAuthor(user),query=new URLSearchParams(params);query.set('author',user.id);return list(delegated,query,true)}
  function doctorSave(user,body,id){const delegated=ownAuthor(user);if(id)doctorDetail(user,id);return save(delegated,{...body,metadata:{...(body?.metadata||{}),authorId:user.id},doctorNames:[user.doctorName]},id)}
  return { list, detail, save, saveCategory, changeStatus, reviewList, reviewDetail, review, doctorList, doctorDetail, doctorSave }

}
module.exports = { createArticles }
