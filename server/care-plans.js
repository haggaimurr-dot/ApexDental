const { randomUUID } = require('node:crypto')
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
function createCarePlans(db, care, sharing) {
  db.exec(`CREATE TABLE IF NOT EXISTS care_plans (
    id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(id),
    title TEXT NOT NULL, nodes_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
    request_key TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS care_plan_nodes (
    plan_id TEXT NOT NULL REFERENCES care_plans(id), task_id TEXT NOT NULL UNIQUE REFERENCES care_tasks(id),
    position INTEGER NOT NULL, PRIMARY KEY(plan_id,position)
  );
  CREATE TABLE IF NOT EXISTS care_plan_events (
    id INTEGER PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES care_plans(id), actor TEXT NOT NULL,
    action TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
  );`)
  db.exec("CREATE TABLE IF NOT EXISTS care_plan_holds (task_id TEXT PRIMARY KEY,prior_status TEXT NOT NULL);")
  function appointment(id) {
    if (typeof id !== 'string' || !id || id.length > 100) fail(400, '就诊记录标识无效')
    const row = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
    if (!row) fail(404, '就诊记录不存在')
    if (row.record_deleted_at) fail(410, '该次健康档案已删除')
    return row
  }
  function medical(user, row) {
    if (!['doctor', 'admin'].includes(user.role)) fail(403, '仅医生或管理员可管理护理计划')
    if (user.role === 'doctor' && row.doctor !== user.doctorName) fail(403, '只能管理本人患者的护理计划')
  }
  function get(user, id, scope) {
    const row = db.prepare('SELECT * FROM care_plans WHERE id=?').get(id)
    if (!row) fail(404, '护理计划不存在')
    const visit = appointment(row.appointment_id)
    if (scope === 'clinic') medical(user, visit)
    else if (row.status === 'draft' || !sharing.canRead(user, visit)) fail(403, '无权查看护理计划')
    return row
  }
  function view(row) {
    const visit = appointment(row.appointment_id)
    const completed = db.prepare("SELECT created_at FROM events WHERE appointment_id=? AND to_status='已完成' ORDER BY id DESC LIMIT 1").get(visit.id)
    const anchorDate = completed ? new Date(Date.parse(completed.created_at) + 8 * 3600000).toISOString().slice(0, 10) : visit.date
    const nodes = row.status === 'draft' ? JSON.parse(row.nodes_json) : db.prepare(`SELECT c.*,a.owner_id,a.member_id,a.patient,a.doctor,a.service
      FROM care_plan_nodes n JOIN care_tasks c ON c.id=n.task_id JOIN appointments a ON a.id=c.appointment_id
      WHERE n.plan_id=? ORDER BY n.position`).all(row.id).map(care.view)
    const done = nodes.filter(node => node.status === 'resolved').length
    return { anchorDate, id: row.id, appointmentId: row.appointment_id, title: row.title, version: row.version,
      status: ['draft','paused','archived'].includes(row.status) ? row.status : done === nodes.length ? 'completed' : 'active',
      patient: visit.patient, doctor: visit.doctor, service: visit.service, memberId: visit.member_id || '', nodes,
      completionRate: nodes.length && row.status !== 'draft' ? `${(done / nodes.length * 100).toFixed(1)}%` : '—',
      submitted: nodes.filter(node => node.feedback).length, lost: nodes.filter(node => node.followupState === 'lost').length,
      stagePhotos: nodes.flatMap(node => (node.feedback?.photos || []).map(photo => ({ ...photo, taskId: node.id, phase: node.phase || node.title, dueDate: node.dueDate }))),
      total: nodes.length, done, overdue: nodes.filter(node => node.status === 'published' && node.dueDate < today()).length,
      attention: nodes.filter(node => node.status === 'waiting_review' && node.feedback?.attention).length }
  }
  function list(user, scope) {
    if (scope === 'clinic') medical(user, { doctor: user.doctorName })
    return db.prepare('SELECT * FROM care_plans ORDER BY created_at DESC,id').all().filter(row => {
      const visit = appointment(row.appointment_id)
      return scope === 'clinic' ? user.role === 'admin' || visit.doctor === user.doctorName : row.status !== 'draft' && sharing.canRead(user, visit)
    }).map(view)
  }
  function content(body, visit, planId) {
    if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80) fail(400, '请填写计划名称（1–80 字）')
    if (!Array.isArray(body.nodes) || body.nodes.length < 1 || body.nodes.length > 20) fail(400, '计划需包含 1–20 个护理节点')
    const used = new Set()
    return body.nodes.map(node => {
      if (!node || typeof node !== 'object') fail(400, '护理节点无效')
      if (node.taskId) {
        if (typeof node.taskId !== 'string' || used.has(node.taskId)) fail(400, '不能重复选择护理任务')
        used.add(node.taskId)
        const task = db.prepare('SELECT * FROM care_tasks WHERE id=?').get(node.taskId)
        if (!task || task.appointment_id !== visit.id || !['published', 'waiting_review', 'resolved'].includes(task.status)) fail(400, '只能归入本次就诊已发送的护理任务')
        const linked = db.prepare('SELECT plan_id FROM care_plan_nodes WHERE task_id=?').get(node.taskId)
        if (linked && linked.plan_id !== planId) fail(409, '该护理任务已属于其他计划')
        return { taskId: task.id, title: task.title, instructions: task.instructions, dueDate: task.due_date }
      }
      care.checkContent(node)
      if (node.phase !== undefined && (typeof node.phase !== 'string' || node.phase.length > 80)) fail(400, '阶段名称最多 80 字')
      if (node.autoNormal !== undefined && typeof node.autoNormal !== 'boolean') fail(400, '自动随访设置无效')
      for (const field of ['lossAfterDays', 'followupIntervalDays']) if (node[field] !== undefined && (!Number.isSafeInteger(node[field]) || node[field] < 1 || node[field] > 30)) fail(400, '跟进间隔应为 1–30 天')
      return { title: node.title.trim(), instructions: node.instructions.trim(), dueDate: node.dueDate,
        phase: node.phase || '', autoNormal: node.autoNormal === true, lossAfterDays: node.lossAfterDays || 7, followupIntervalDays: node.followupIntervalDays || 3 }
    })
  }
  function event(row, user, action) {
    db.prepare('INSERT INTO care_plan_events (plan_id,actor,action,version,snapshot,created_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, user.id, action, row.version, JSON.stringify({ title: row.title, nodes: JSON.parse(row.nodes_json) }), new Date().toISOString())
  }
  function save(user, body, id) {
    if (!body || typeof body !== 'object') fail(400, '计划内容无效')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = id ? get(user, id, 'clinic') : null
      const visit = appointment(row ? row.appointment_id : body.appointmentId)
      medical(user, visit)
      if (visit.status !== '已完成' || !visit.owner_id) fail(409, '需完成接诊并关联患者账号后安排计划')
      if (!id && (typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100)) fail(400, '缺少请求标识')
      const existing = !id ? db.prepare('SELECT * FROM care_plans WHERE request_key=?').get(body.requestKey) : null
      const nodes = content(body, visit, id || existing?.id), title = body.title.trim(), snapshot = JSON.stringify(nodes)
      if (!id) {
        if (existing) {
          if (existing.created_by !== user.id || existing.appointment_id !== visit.id || existing.title !== title || existing.nodes_json !== snapshot) fail(409, '请求标识已用于其他计划内容')
          db.exec('COMMIT'); return view(existing)
        }
      }
      if (row && (row.status !== 'draft' || row.version !== body.version)) fail(409, '计划已变更，请重新加载后编辑')
      const planId = id || `CP-${randomUUID()}`, version = row ? row.version + 1 : 1
      if (row) db.prepare('UPDATE care_plans SET title=?,nodes_json=?,version=? WHERE id=?').run(title, snapshot, version, id)
      else db.prepare('INSERT INTO care_plans VALUES (?,?,?,?,?,?,?,?,?,?)').run(planId, visit.id, title, snapshot, 'draft', version, body.requestKey, user.id, new Date().toISOString(), null)
      const saved = db.prepare('SELECT * FROM care_plans WHERE id=?').get(planId)
      event(saved, user, row ? 'updated' : 'created'); db.exec('COMMIT'); return view(saved)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function publish(user, id, body) {
    if (!body || !Number.isSafeInteger(body.version)) fail(400, '计划版本无效')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = get(user, id, 'clinic')
      // A retry after a lost response must not create another set of tasks.
      if (row.status === 'active' && row.version === body.version + 1) { db.exec('COMMIT'); return view(row) }
      if (row.status !== 'draft' || row.version !== body.version) fail(409, '计划已变更，请重新加载')
      const visit = appointment(row.appointment_id)
      if (visit.status !== '已完成' || !visit.owner_id) fail(409, '该就诊不能发送护理计划')
      const nodes = content({ title: row.title, nodes: JSON.parse(row.nodes_json) }, visit, id), timestamp = new Date().toISOString()
      nodes.forEach((node, position) => {
        const taskId = node.taskId || `C-${randomUUID()}`
        if (!node.taskId) {
          db.prepare(`INSERT INTO care_tasks (id,appointment_id,title,instructions,due_date,status,request_key,created_by,created_at,published_at)
            VALUES (?,?,?,?,?,'published',?,?,?,?)`).run(taskId, visit.id, node.title, node.instructions, node.dueDate, `plan:${id}:${position}`, user.id, timestamp, timestamp)
          db.prepare('INSERT INTO care_events (task_id,actor,action,created_at) VALUES (?,?,?,?)').run(taskId, user.id, 'published', timestamp)
        }
        db.prepare('INSERT INTO care_plan_nodes VALUES (?,?,?)').run(id, taskId, position)
      })
      db.prepare("UPDATE care_plans SET status='active',version=version+1,published_at=? WHERE id=?").run(timestamp, id)
      const saved = db.prepare('SELECT * FROM care_plans WHERE id=?').get(id)
      event(saved, user, 'published'); db.exec('COMMIT'); return view(saved)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function manage(user,id,body) {
    if (!body || !['pause','resume','archive','append','update-node'].includes(body.action)) fail(400,'计划操作无效')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row=get(user,id,'clinic'),visit=appointment(row.appointment_id)
      if(row.version!==body.version)fail(409,'计划已更新，请刷新')
      if(!['active','paused'].includes(row.status))fail(409,'当前计划不支持维护')
      const links=db.prepare('SELECT c.*,n.position FROM care_plan_nodes n JOIN care_tasks c ON c.id=n.task_id WHERE n.plan_id=? ORDER BY n.position').all(id),now=new Date().toISOString()
      const pending=links.filter(node=>['published','paused','scheduled'].includes(node.status))
      if(body.action==='pause') {
        if(row.status!=='active')fail(409,'计划已暂停')
        for(const task of pending){db.prepare('INSERT OR REPLACE INTO care_plan_holds VALUES(?,?)').run(task.id,task.status);db.prepare("UPDATE care_tasks SET status='paused' WHERE id=?").run(task.id)}
        db.prepare("UPDATE care_plans SET status='paused' WHERE id=?").run(id)
      } else if(body.action==='resume') {
        if(row.status!=='paused')fail(409,'计划未暂停')
        for(const task of pending){const prior=db.prepare('SELECT prior_status FROM care_plan_holds WHERE task_id=?').get(task.id)?.prior_status;db.prepare("UPDATE care_tasks SET status=? WHERE id=? AND status='paused'").run(prior==='scheduled'?'scheduled':'published',task.id)}
        db.prepare("UPDATE care_plans SET status='active' WHERE id=?").run(id)
      } else if(body.action==='archive') {
        if(links.some(node=>node.status==='waiting_review'))fail(409,'请先处理已提交反馈再终止计划')
        for(const task of pending)db.prepare("UPDATE care_tasks SET status='archived' WHERE id=?").run(task.id)
        db.prepare("UPDATE care_plans SET status='archived' WHERE id=?").run(id)
      } else if(body.action==='append') {
        if(links.length>=20)fail(400,'单计划最多20个节点')
        const node=content({title:row.title,nodes:[body.node]},visit,id)[0]
        if(node.taskId)fail(400,'维护时请添加新节点')
        const taskId=`C-${randomUUID()}`
        db.prepare('INSERT INTO care_tasks (id,appointment_id,title,instructions,due_date,status,request_key,created_by,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(taskId,visit.id,node.title,node.instructions,node.dueDate,row.status==='paused'?'paused':'published',`append:${id}:${row.version}`,user.id,now,now)
        db.prepare('INSERT INTO care_plan_nodes VALUES(?,?,?)').run(id,taskId,links.length)
        const nodes=JSON.parse(row.nodes_json);nodes.push(node);db.prepare('UPDATE care_plans SET nodes_json=? WHERE id=?').run(JSON.stringify(nodes),id)
      } else {
        const task=links.find(node=>node.id===body.taskId)
        if(!task||!['published','paused','scheduled'].includes(task.status))fail(409,'只能修改未反馈的节点')
        const node=content({title:row.title,nodes:[body.node]},visit,id)[0]
        if(node.taskId)fail(400,'节点内容无效')
        db.prepare('UPDATE care_tasks SET title=?,instructions=?,due_date=? WHERE id=?').run(node.title,node.instructions,node.dueDate,task.id)
        const nodes=JSON.parse(row.nodes_json);nodes[task.position]=node;db.prepare('UPDATE care_plans SET nodes_json=? WHERE id=?').run(JSON.stringify(nodes),id)
      }
      db.prepare('UPDATE care_plans SET version=version+1 WHERE id=?').run(id)
      const saved=db.prepare('SELECT * FROM care_plans WHERE id=?').get(id);event(saved,user,body.action)
      for(const task of pending)db.prepare('INSERT INTO care_events(task_id,actor,action,created_at) VALUES(?,?,?,?)').run(task.id,user.id,`plan-${body.action}`,now)
      db.exec('COMMIT');return view(saved)
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  return { list, detail: (user, id, scope) => view(get(user, id, scope)), save, publish, manage }
}
module.exports = { createCarePlans }
