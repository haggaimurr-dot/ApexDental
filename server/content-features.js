const { randomUUID } = require('node:crypto')
function fail(status, message) { const e = new Error(message); e.status = status; throw e }
function createContentFeatures(db, articles) {
  db.exec(`CREATE TABLE IF NOT EXISTS article_activity (id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,article_id TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS article_favorites (user_id TEXT NOT NULL,article_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,article_id));`)
  function activity(user, id, body) {
    articles.detail(user, id)
    if (!body || !['read','share','booking'].includes(body.kind) || typeof (body.source || '') !== 'string' || (body.source || '').length > 60) fail(400, '阅读活动无效')
    // Read history records one visit per minute; no fabricated counts from duplicate refreshes.
    if (body.kind === 'read' && db.prepare("SELECT 1 FROM article_activity WHERE user_id=? AND article_id=? AND kind='read' AND created_at>?").get(user.id,id,new Date(Date.now()-60000).toISOString())) return { recorded: false }
    db.prepare('INSERT INTO article_activity (user_id,article_id,kind,source,created_at) VALUES (?,?,?,?,?)').run(user.id,id,body.kind,body.source || '',new Date().toISOString())
    if(body.kind==='read'&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='daily_habits'").get())db.prepare('INSERT OR IGNORE INTO daily_habits VALUES(?,?,?,?)').run(user.id,new Date(Date.now()+8*3600000).toISOString().slice(0,10),'reading',new Date().toISOString())
    return { recorded: true }
  }
  function favorite(user,id,body) {
    articles.detail(user,id)
    if (typeof body?.selected !== 'boolean') fail(400,'收藏状态无效')
    if (body.selected) db.prepare('INSERT OR IGNORE INTO article_favorites VALUES (?,?,?)').run(user.id,id,new Date().toISOString())
    else db.prepare('DELETE FROM article_favorites WHERE user_id=? AND article_id=?').run(user.id,id)
    return { selected: body.selected }
  }
  function state(user,id) { articles.detail(user,id); return { selected: !!db.prepare('SELECT 1 FROM article_favorites WHERE user_id=? AND article_id=?').get(user.id,id) } }
  function library(user, params) {
    const kind = params.get('kind') || 'favorites', page = Number(params.get('page') || 1)
    if (!['favorites','history'].includes(kind) || !Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400,'阅读列表筛选无效')
    const from = kind === 'favorites' ? 'article_favorites' : 'article_activity', extra = kind === 'history' ? "AND kind='read'" : ''
    const query = `FROM ${from} WHERE user_id=? ${extra} AND article_id IN (SELECT id FROM articles WHERE status='published') GROUP BY article_id`
    const total = db.prepare(`SELECT COUNT(*) total FROM (SELECT article_id ${query})`).get(user.id).total
    const items = db.prepare(`SELECT article_id,MAX(created_at) lastSeen ${query} ORDER BY lastSeen DESC,article_id LIMIT 20 OFFSET ?`).all(user.id,(page-1)*20).map(row => ({ ...articles.detail(user,row.article_id),lastSeen:row.lastSeen }))
    return { items,total,page,hasMore:page*20<total }
  }
  function recommend(user,params) {
    const population = params.get('population') || '', symptom = params.get('symptom') || ''
    const candidates = articles.list(user,new URLSearchParams({population,symptom})).items
    const favorites = new Set(db.prepare('SELECT article_id FROM article_favorites WHERE user_id=?').all(user.id).map(row=>row.article_id))
    return { items: candidates.sort((a,b)=>Number(favorites.has(b.id))-Number(favorites.has(a.id))).slice(0,6), basis: population || symptom ? '按你选择的人群与症状筛选' : '最新发布的内容；优先显示已收藏文章', diagnostic: false }
  }
  function stats(user) {
    if (!user.isStaff || user.role !== 'admin') fail(403,'仅管理员可查看内容统计')
    const since = new Date(Date.now()-30*86400000).toISOString()
    return { period:'近30天', items:db.prepare(`SELECT a.id,a.title,
      (SELECT COUNT(*) FROM appointments b WHERE b.origin_article=a.id AND b.created_at>=?) bookings,
      (SELECT COUNT(*) FROM article_activity x WHERE x.article_id=a.id AND x.kind='read' AND x.created_at>=?) reads,
      (SELECT COUNT(DISTINCT user_id) FROM article_activity x WHERE x.article_id=a.id AND x.kind='read' AND x.created_at>=?) readers,
      (SELECT COUNT(*) FROM article_favorites f WHERE f.article_id=a.id) favorites,
      (SELECT COUNT(*) FROM article_activity x WHERE x.article_id=a.id AND x.kind='share' AND x.created_at>=?) shares,
      (SELECT COUNT(*) FROM article_activity x WHERE x.article_id=a.id AND x.kind='booking' AND x.created_at>=?) bookingEntries
      FROM articles a ORDER BY reads DESC,a.id`).all(since,since,since,since,since), note:'预约入口点击量不等于成功预约量；分享记录表示发起分享。' }
  }
  return {activity,favorite,state,library,recommend,stats}
}
function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'百科资料格式无效')
  const result = {kind:value.kind || 'article',blocks:[],faq:[],references:[],authorId:value.authorId || '',featured:value.featured === true}
  if (!['article','disease','service'].includes(result.kind)) fail(400,'内容类型无效')
  for (const key of ['definition','manifestations','causes','consultation','examination','treatment','preparation','aftercare']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 2000)) fail(400,'百科字段最多2000字')
    result[key]=(value[key]||'').trim()
  }
  for (const [field,max] of [['blocks',60],['faq',20],['references',20]]) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length > max)) fail(400,'内容条目数量无效')
  }
  result.blocks=(value.blocks||[]).map(row=>{
    if (!row || !['heading','paragraph'].includes(row.type) || typeof row.text!=='string' || !row.text.trim() || row.text.length>2000) fail(400,'图文段落无效')
    return {type:row.type,text:row.text.trim()}
  })
  result.faq=(value.faq||[]).map(row=>{
    if (!row || typeof row.question!=='string' || typeof row.answer!=='string' || !row.question.trim() || !row.answer.trim() || row.question.length>200 || row.answer.length>2000) fail(400,'常见问题无效')
    return {question:row.question.trim(),answer:row.answer.trim()}
  })
  result.references=(value.references||[]).map(row=>{
    if (!row || typeof row.title!=='string' || !row.title.trim() || row.title.length>200 || typeof row.url!=='string' || row.url.length>1000) fail(400,'来源资料无效')
    try { const url=new URL(row.url); if(url.protocol!=='https:' || url.username || url.password) throw Error() } catch {fail(400,'来源必须是有效HTTPS地址')}
    return {title:row.title.trim(),url:row.url}
  })
  if (typeof result.authorId!=='string' || result.authorId.length>100) fail(400,'署名标识无效')
  return result
}
module.exports={createContentFeatures,metadata}
