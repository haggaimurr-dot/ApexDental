const { randomUUID } = require('node:crypto')
function createCareTemplates(db, catalog) {
  db.exec(`CREATE TABLE IF NOT EXISTS care_templates (
    id TEXT PRIMARY KEY,name TEXT NOT NULL,title TEXT NOT NULL,instructions TEXT NOT NULL,
    service TEXT NOT NULL,feedback_days INTEGER NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL,
    created_by TEXT NOT NULL,author_name TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS care_template_versions (
    template_id TEXT NOT NULL,version INTEGER NOT NULL,name TEXT NOT NULL,title TEXT NOT NULL,
    instructions TEXT NOT NULL,service TEXT NOT NULL,feedback_days INTEGER NOT NULL,
    enabled INTEGER NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(template_id,version),FOREIGN KEY(template_id) REFERENCES care_templates(id)
  );
  CREATE TABLE IF NOT EXISTS care_template_usage (
    task_id TEXT PRIMARY KEY,template_id TEXT NOT NULL,template_version INTEGER NOT NULL,
    FOREIGN KEY(task_id) REFERENCES care_tasks(id),
    FOREIGN KEY(template_id,template_version) REFERENCES care_template_versions(template_id,version)
  );`)
  db.exec("CREATE TABLE IF NOT EXISTS care_template_reviews(template_id TEXT PRIMARY KEY,template_version INTEGER NOT NULL,status TEXT NOT NULL,editor TEXT NOT NULL,reviewer TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS care_template_review_events(id INTEGER PRIMARY KEY,template_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);")
  function fail(status, message) { const error = new Error(message); error.status = status; throw error }
  function requireMedical(user) { if (!['doctor', 'admin'].includes(user.role)) fail(403, '仅医生或管理员可使用护理模板') }
  function view(row, user) {
    const review=db.prepare('SELECT * FROM care_template_reviews WHERE template_id=?').get(row.id)
    return { reviewStatus:review?.status || 'legacy', editorId:review?.editor || row.created_by, reviewNote:review?.note || '', id: row.id, name: row.name, title: row.title, instructions: row.instructions, service: row.service,
      feedbackDays: row.feedback_days, enabled: !!row.enabled, version: row.version, authorName: row.author_name,
      mayEdit: user.role === 'admin' || row.created_by === user.id }
  }
  function list(user, includeDisabled) {
    requireMedical(user)
    const rows = includeDisabled ? db.prepare('SELECT * FROM care_templates ORDER BY enabled DESC,name,id').all() : db.prepare('SELECT * FROM care_templates WHERE enabled=1 ORDER BY name,id').all()
    return rows.map(row => view(row, user)).filter(row=>includeDisabled||['approved','legacy'].includes(row.reviewStatus))
  }
  function save(user, body, id) {
    requireMedical(user)
    for (const [key, label, max] of [['name','模板名称',60],['title','任务标题',80],['instructions','护理说明',3000]]) {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > max) fail(400, `请填写${label}（最多 ${max} 字）`)
    }
    if (!['通用', ...catalog.names('services', true)].includes(body.service) || !Number.isSafeInteger(body.feedbackDays) || body.feedbackDays < 0 || body.feedbackDays > 365 || typeof body.enabled !== 'boolean') fail(400, '请检查适用项目、反馈间隔（0–365 天）和启用状态')
    if (id && (!Number.isSafeInteger(body.version) || body.version < 1)) fail(400, '模板版本无效，请重新加载')
    if (!id && (typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100)) fail(400, '缺少有效的请求标识')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = id ? db.prepare('SELECT * FROM care_templates WHERE id=?').get(id) : db.prepare('SELECT * FROM care_templates WHERE request_key=?').get(body.requestKey)
      if (id && !row) fail(404, '模板不存在')
      if (row && user.role !== 'admin' && row.created_by !== user.id) fail(403, '只能修改自己创建的模板')
      if (row && !id) {
        if (row.created_by !== user.id) fail(409, '请求标识已使用')
        db.exec('COMMIT'); return view(row, user)
      }
      const name = body.name.trim(), title = body.title.trim(), instructions = body.instructions.trim(), enabled = Number(body.enabled)
      const unchanged = row && row.name === name && row.title === title && row.instructions === instructions && row.service === body.service && row.feedback_days === body.feedbackDays && row.enabled === enabled
      if (unchanged && [body.version, body.version + 1].includes(row.version)) { db.exec('COMMIT'); return view(row, user) }
      if (row && row.version !== body.version) fail(409, '模板已更新，请返回模板列表重新编辑')
      const templateId = row ? row.id : `CT-${randomUUID()}`, version = row ? row.version + 1 : 1, timestamp = new Date().toISOString()
      if (row) db.prepare('UPDATE care_templates SET name=?,title=?,instructions=?,service=?,feedback_days=?,enabled=?,version=?,updated_at=? WHERE id=?').run(name,title,instructions,body.service,body.feedbackDays,enabled,version,timestamp,templateId)
      else db.prepare('INSERT INTO care_templates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(templateId,name,title,instructions,body.service,body.feedbackDays,enabled,version,user.id,user.displayName || user.doctorName || '诊所管理员',body.requestKey,timestamp)
      db.prepare('INSERT INTO care_template_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(templateId,version,name,title,instructions,body.service,body.feedbackDays,enabled,user.id,timestamp)
      db.prepare("INSERT INTO care_template_reviews(template_id,template_version,status,editor) VALUES(?,?,'draft',?) ON CONFLICT(template_id) DO UPDATE SET template_version=excluded.template_version,status='draft',editor=excluded.editor,reviewer='',note=''").run(templateId,version,user.id)
      const saved = db.prepare('SELECT * FROM care_templates WHERE id=?').get(templateId)
      db.exec('COMMIT'); return view(saved, user)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  // Called within care publishing's transaction; the task stores its own final text.
  function recordUsage(user, taskId, body, service) {
    if (!body.templateId) return
    requireMedical(user)
    if (typeof body.templateId !== 'string' || body.templateId.length > 100 || !Number.isSafeInteger(body.templateVersion)) fail(400, '模板引用无效，请重新选择')
    const template = db.prepare('SELECT * FROM care_templates WHERE id=?').get(body.templateId)
    if (!template || !template.enabled || template.version !== body.templateVersion) fail(409, '护理模板已更新或停用，请重新选择模板或改为手动填写')
    if (template.service !== '通用' && template.service !== service) fail(400, '模板不适用于本次服务项目')
    const review=db.prepare('SELECT * FROM care_template_reviews WHERE template_id=?').get(template.id)
    if(review&&review.status!=='approved')fail(409,'模板需要独立审核通过后才能使用')
    db.prepare('INSERT INTO care_template_usage VALUES (?,?,?)').run(taskId, template.id, template.version)
  }
  function review(user,id,body){
    requireMedical(user)
    if(!['submit','withdraw','approve','reject'].includes(body?.decision))fail(400,'审核操作无效')
    db.exec('BEGIN IMMEDIATE')
    try{const template=db.prepare('SELECT * FROM care_templates WHERE id=?').get(id),row=db.prepare('SELECT * FROM care_template_reviews WHERE template_id=?').get(id)
      if(!template||!row)fail(404,'待审核模板不存在')
      if(template.version!==body.version||row.template_version!==body.version)fail(409,'模板版本已更新')
      const isReview=['approve','reject'].includes(body.decision)
      if(isReview&&row.editor===user.id)fail(403,'不能审核本人维护的模板')
      if(!isReview&&row.editor!==user.id&&user.role!=='admin')fail(403,'无权提交或撤回此模板')
      if((isReview||body.decision==='withdraw')&&row.status!=='pending'||body.decision==='submit'&&!['draft','rejected'].includes(row.status))fail(409,'当前模板不能执行此操作')
      const note=isReview?body.note:'';if(isReview&&(typeof note!=='string'||!note.trim()||note.length>1000))fail(400,'请填写审核意见')
      db.prepare('UPDATE care_template_reviews SET status=?,reviewer=?,note=? WHERE template_id=?').run({submit:'pending',withdraw:'draft',approve:'approved',reject:'rejected'}[body.decision],isReview?user.id:'',note,id)
      db.prepare('INSERT INTO care_template_review_events(template_id,actor,action,version,note,created_at) VALUES(?,?,?,?,?,?)').run(id,user.id,body.decision,template.version,note,new Date().toISOString())
      const result=view(template,user);db.exec('COMMIT');return result
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  return { list, save, recordUsage, review }
}
module.exports = { createCareTemplates }
