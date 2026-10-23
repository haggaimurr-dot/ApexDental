const { randomUUID } = require('node:crypto')
const kinds = { confirmation: '预约确认', visit_day: '就诊前一天提醒', visit_soon: '临近就诊提醒', care: '护理反馈提醒', recall: '复查提醒' }
function fail(status, message) { const error = new Error(message); error.status = status; throw error }

// Each template must use the real account's field names. Values reference these safe tokens.
function configuration(env) {
  let templates = {}
  try { templates = JSON.parse(env.APEX_WECHAT_TEMPLATES || '{}') } catch { throw new Error('APEX_WECHAT_TEMPLATES 必须为有效 JSON') }
  for (const [kind, template] of Object.entries(templates)) {
    if (!kinds[kind] || !template || typeof template.id !== 'string' || !template.id || !template.fields || !Object.keys(template.fields).length) throw new Error('订阅模板配置无效')
    for (const [key, token] of Object.entries(template.fields)) {
      if (!/^(thing|time|date|name|character_string|phrase|number)\d+$/.test(key) || !['title', 'date', 'time', 'doctor', 'service'].includes(token)) throw new Error('订阅模板字段映射无效')
    }
  }
  const state = env.APEX_WECHAT_MESSAGE_STATE || 'formal'
  if (!['formal', 'trial', 'developer'].includes(state)) throw new Error('微信消息环境配置无效')
  return { templates, state, ready: /^wx[0-9a-f]{16}$/i.test(env.APEX_WECHAT_APPID || '') && !!env.APEX_WECHAT_SECRET }
}

function createNotifications(db, { env = process.env, fetcher = fetch, now = () => Date.now() } = {}) {
  const config = configuration(env)
  const stamp = () => new Date(now()).toISOString()
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_messages (
      id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL,
      appointment_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
      snapshot TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, read_at TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      template_id TEXT NOT NULL DEFAULT '', claim_id TEXT, lease_until TEXT
    );
    CREATE INDEX IF NOT EXISTS notification_owner ON notification_messages(owner_id,created_at);
    CREATE TABLE IF NOT EXISTS notification_attempts (
      id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, attempted_at TEXT NOT NULL,
      outcome TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      owner_id TEXT NOT NULL, template_id TEXT NOT NULL, choice TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,template_id)
    );
    CREATE TABLE IF NOT EXISTS notification_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `)
  // Historical confirmations are not replayed when deploying this feature.
  db.prepare("INSERT OR IGNORE INTO notification_meta VALUES ('confirmation_cursor',?)").run(String(db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get().n))
  const insert = db.prepare(`INSERT OR IGNORE INTO notification_messages
    (id,dedupe_key,owner_id,appointment_id,kind,source_id,snapshot,title,body,created_at,expires_at,next_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  function enqueue(a, kind, source, snapshot, date, expires, key) {
    if (!a.owner_id) return
    insert.run(randomUUID(), key, a.owner_id, a.id, kind, source, snapshot, kinds[kind],
      `${date} · ${a.service} · ${a.doctor}。${kind === 'care' ? '请打开诊后护理提交恢复反馈。' : kind === 'recall' ? '请查看复查安排并选择预约时段。' : '请查看预约详情，以最新安排为准。'}`,
      stamp(), expires, stamp())
  }
  function current(message) {
    const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(message.appointment_id)
    if (!a || a.owner_id !== message.owner_id || message.expires_at <= stamp()) return false
    if(message.dedupe_key.startsWith('closure:')){const info=JSON.parse(message.snapshot),closure=db.prepare('SELECT * FROM clinic_closures WHERE id=?').get(message.source_id);return closure&&closure.enabled===1&&closure.version===info.version&&a.date===info.date&&['待确认','已预约','取消申请中'].includes(a.status)}
    if(message.dedupe_key.startsWith('recall-node:')){const node=db.prepare('SELECT * FROM recall_nodes WHERE id=?').get(message.source_id);return node&&String(node.version)===message.snapshot&&!a.record_deleted_at&&!db.prepare("SELECT 1 FROM appointments WHERE recall_node_id=? AND status NOT IN ('已取消','爽约')").get(node.id)}
    if (message.kind === 'care') {
      const task = db.prepare('SELECT * FROM care_tasks WHERE id=?').get(message.source_id)
      return task && task.status === 'published' && task.due_date === message.snapshot
    }
    if (message.kind === 'recall') {
      const plan = db.prepare('SELECT * FROM recall_plans WHERE appointment_id=?').get(a.id)
      return plan && String(plan.version) === message.snapshot && !db.prepare("SELECT 1 FROM appointments WHERE recall_id=? AND status<>'已取消'").get(a.id)
    }
    return a.status === '已预约' && `${a.date} ${a.slot}` === message.snapshot
  }
  function scan() {
    const rules=db.prepare("SELECT 1 FROM sqlite_master WHERE name='booking_rules'").get()?JSON.parse(db.prepare('SELECT payload FROM booking_rules WHERE id=1').get()?.payload||'{}'):{}
    const soonWindow=(rules.visitSoonHours || 2)*3600000,dayWindow=(rules.visitDayHours || 24)*3600000
    const today = new Date(now() + 8 * 3600000).toISOString().slice(0, 10)
    db.exec('BEGIN IMMEDIATE')
    try {
      const cursor = Number(db.prepare("SELECT value FROM notification_meta WHERE key='confirmation_cursor'").get().value)
      const events = db.prepare("SELECT e.id AS event_id,a.* FROM events e JOIN appointments a ON a.id=e.appointment_id WHERE e.id>? AND e.to_status='已预约' AND e.id=(SELECT MAX(latest.id) FROM events latest WHERE latest.appointment_id=a.id AND latest.to_status='已预约') ORDER BY e.id").all(cursor)
      for (const a of events) {
        const start = new Date(`${a.date}T${a.slot}:00+08:00`).toISOString()
        if (a.status === '已预约' && start > stamp()) enqueue(a, 'confirmation', a.id, `${a.date} ${a.slot}`, `${a.date} ${a.slot}`, start, `confirmation:${a.event_id}`)
      }
      db.prepare("UPDATE notification_meta SET value=? WHERE key='confirmation_cursor'").run(String(db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get().n))
      for (const a of db.prepare("SELECT * FROM appointments WHERE status='已预约' AND owner_id<>'' AND date>=?").all(today)) {
        const start = new Date(`${a.date}T${a.slot}:00+08:00`).getTime(), remaining = start - now()
        for (const [kind, window] of [['visit_day', dayWindow], ['visit_soon', soonWindow]]) {
          if (remaining > (kind === 'visit_day' ? soonWindow : 0) && remaining <= window) enqueue(a, kind, a.id, `${a.date} ${a.slot}`, `${a.date} ${a.slot}`, new Date(start).toISOString(), `${kind}:${a.id}:${a.date}:${a.slot}`)
        }
      }
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='clinic_closures'").get())for(const a of db.prepare("SELECT a.*,c.id closure_id,c.version closure_version,c.reason closure_reason FROM clinic_closures c JOIN appointments a ON a.date=c.date AND (c.doctor='' OR c.doctor=a.doctor) WHERE c.enabled=1 AND a.owner_id<>'' AND a.status IN ('待确认','已预约','取消申请中') AND a.date>=?").all(today)){const key=`closure:${a.closure_id}:${a.closure_version}:${a.id}`;insert.run(randomUUID(),key,a.owner_id,a.id,'confirmation',a.closure_id,JSON.stringify({version:a.closure_version,date:a.date}),'停诊安排需核实',`${a.date} ${a.slot} · ${a.closure_reason}。原预约仍保留，请联系诊所核实后续安排。`,stamp(),new Date(`${a.date}T23:59:59+08:00`).toISOString(),stamp())}
      const leadDay=new Date(Date.parse(today)+(rules.recallAheadDays||0)*86400000).toISOString().slice(0,10)
      // Due reminders run at 09:00 Beijing time; an overdue reminder is generated once after downtime.
      if (new Date(now() + 8 * 3600000).getUTCHours() >= (rules.reminderHour === undefined ? 9 : rules.reminderHour)) {
        for (const a of db.prepare("SELECT a.*,c.id AS task_id,c.due_date FROM care_tasks c JOIN appointments a ON a.id=c.appointment_id WHERE c.status='published' AND c.due_date<=?").all(today)) {
          enqueue(a, 'care', a.task_id, a.due_date, a.due_date, new Date(now() + 7 * 86400000).toISOString(), `care:${a.task_id}:${a.due_date}`)
        }
        for (const a of db.prepare("SELECT a.*,r.due_date,r.version AS plan_version FROM recall_plans r JOIN appointments a ON a.id=r.appointment_id WHERE r.due_date<=? AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.recall_id=a.id AND b.status<>'已取消')").all(leadDay)) {
          enqueue(a, 'recall', a.id, String(a.plan_version), a.due_date, new Date(now() + 7 * 86400000).toISOString(), `recall:${a.id}:${a.plan_version}`)
        }
      }
      if(new Date(now()+8*3600000).getUTCHours()>=(rules.reminderHour===undefined?9:rules.reminderHour)&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='recall_nodes'").get())for(const a of db.prepare("SELECT a.*,n.id node_id,n.version node_version,n.due_date FROM recall_nodes n JOIN appointments a ON a.id=n.appointment_id WHERE a.record_deleted_at='' AND n.due_date<=? AND NOT EXISTS(SELECT 1 FROM appointments b WHERE b.recall_node_id=n.id AND b.status NOT IN ('已取消','爽约'))").all(leadDay))enqueue(a,'recall',a.node_id,String(a.node_version),a.due_date,new Date(Math.max(now()+7*86400000,Date.parse(a.due_date)+7*86400000)).toISOString(),`recall-node:${a.node_id}:${a.node_version}`)
      for (const m of db.prepare("SELECT * FROM notification_messages WHERE status NOT IN ('obsolete','sending')").all()) {
        if (!current(m)) db.prepare("UPDATE notification_messages SET status='obsolete',error='安排已变更、已完成或提醒已过期' WHERE id=?").run(m.id)
      }
      // An interrupted send may already have reached WeChat; never replay it automatically.
      for (const m of db.prepare("SELECT id FROM notification_messages WHERE status='sending' AND lease_until<=?").all(stamp())) {
        db.prepare("UPDATE notification_messages SET status='uncertain',error='发送进程中断，结果未知，请核实后重试',claim_id=NULL,lease_until=NULL WHERE id=?").run(m.id)
        db.prepare('INSERT INTO notification_attempts (message_id,attempted_at,outcome,code,detail) VALUES (?,?,?,?,?)').run(m.id, stamp(), 'uncertain', 'INTERRUPTED', '发送进程中断，结果未知')
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  let token = '', tokenUntil = 0, running = false
  async function accessToken() {
    if (token && tokenUntil > now()) return token
    const params = new URLSearchParams({ grant_type: 'client_credential', appid: env.APEX_WECHAT_APPID, secret: env.APEX_WECHAT_SECRET })
    const response = await fetcher(`https://api.weixin.qq.com/cgi-bin/token?${params}`, { signal: AbortSignal.timeout(5000) })
    const result = await response.json()
    if (!response.ok || !result.access_token) throw Object.assign(new Error('微信凭证获取失败'), { code: String(result.errcode || response.status), beforeSend: true })
    token = result.access_token; tokenUntil = now() + Math.max(0, Number(result.expires_in || 7200) - 300) * 1000
    return token
  }
  function finish(m, status, code, detail) {
    const retryAt = new Date(now() + Math.min(3600000, 60000 * 2 ** m.attempts)).toISOString()
    db.prepare('UPDATE notification_messages SET status=?,error=?,next_at=?,claim_id=NULL,lease_until=NULL WHERE id=? AND claim_id=?').run(status, detail, retryAt, m.id, m.claim_id)
    db.prepare('INSERT INTO notification_attempts (message_id,attempted_at,outcome,code,detail) VALUES (?,?,?,?,?)').run(m.id, stamp(), status, code, detail)
  }
  async function tick() {
    if (running) return
    running = true
    try {
      scan()
      for (const candidate of db.prepare("SELECT * FROM notification_messages WHERE status IN ('pending','retry') AND next_at<=? ORDER BY created_at LIMIT 20").all(stamp())) {
        const template = config.templates[candidate.kind]
        const subject = db.prepare('SELECT subject FROM users WHERE id=?').get(candidate.owner_id)?.subject || ''
        const grant = template && db.prepare('SELECT choice FROM notification_subscriptions WHERE owner_id=? AND template_id=?').get(candidate.owner_id, template.id)
        if (!config.ready || !template || !subject.startsWith('wx:') || grant?.choice !== 'accept') {
          db.prepare("UPDATE notification_messages SET status='blocked',error=? WHERE id=? AND status IN ('pending','retry')").run(!config.ready || !template ? '微信推送未配置，已保留站内消息' : !subject.startsWith('wx:') ? '演示账号不支持微信推送' : '尚未获得订阅授权，已保留站内消息', candidate.id)
          continue
        }
        const claim = randomUUID()
        if (!db.prepare("UPDATE notification_messages SET status='sending',attempts=attempts+1,claim_id=?,lease_until=?,template_id=? WHERE id=? AND status IN ('pending','retry') AND attempts<5").run(claim, new Date(now() + 60000).toISOString(), template.id, candidate.id).changes) continue
        const m = db.prepare('SELECT * FROM notification_messages WHERE id=?').get(candidate.id)
        let sending = false
        try {
          const credential = await accessToken()
          if (!current(m)) { finish(m, 'obsolete', '', '安排已变更或已完成'); continue }
          if (db.prepare('SELECT choice FROM notification_subscriptions WHERE owner_id=? AND template_id=?').get(m.owner_id, template.id)?.choice !== 'accept') { finish(m, 'blocked', 'NO_CONSENT', '订阅授权已撤回'); continue }
          const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(m.appointment_id)
          const date = m.kind === 'care' ? m.snapshot : m.kind === 'recall' ? (m.dedupe_key.startsWith('recall-node:')?db.prepare('SELECT due_date FROM recall_nodes WHERE id=?').get(m.source_id).due_date:db.prepare('SELECT due_date FROM recall_plans WHERE appointment_id=?').get(a.id).due_date) : a.date
          const values = { title: m.title, date, time: `${date} ${m.kind === 'care' || m.kind === 'recall' ? '09:00' : a.slot}`, doctor: a.doctor, service: a.service }
          const data = Object.fromEntries(Object.entries(template.fields).map(([key, value]) => [key, { value: values[value] }]))
          sending = true
          const response = await fetcher(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(credential)}`, {
            method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ touser: subject.slice(3), template_id: template.id, page: `pages/index/index?notification=${m.id}`, data, miniprogram_state: config.state })
          })
          const result = await response.json(), code = String(result.errcode ?? response.status)
          if (response.ok && result.errcode === 0) finish(m, 'sent', '0', '')
          else {
            if (['40001', '42001', '40014'].includes(code)) { token = ''; tokenUntil = 0 }
            const transient = ['-1', '45009', '40001', '42001', '40014'].includes(code)
            finish(m, code === '43101' ? 'blocked' : transient && m.attempts < 3 ? 'retry' : 'failed', code, `微信返回错误 ${code}，站内消息可查看`)
          }
        } catch (error) {
          finish(m, sending ? 'uncertain' : m.attempts < 3 ? 'retry' : 'failed', error.code || 'NETWORK', sending ? '发送结果未知，请核实后重试；站内消息已保留' : '微信凭证获取失败，等待重试')
        }
      }
    } finally { running = false }
  }
  function settings(user) {
    const subject = db.prepare('SELECT subject FROM users WHERE id=?').get(user.id)?.subject || ''
    return { ready: config.ready && subject.startsWith('wx:') && Object.keys(config.templates).length > 0, templates: Object.entries(config.templates).map(([kind, t]) => ({ kind, title: kinds[kind], id: t.id })),
      choices: db.prepare('SELECT template_id AS templateId,choice FROM notification_subscriptions WHERE owner_id=?').all(user.id) }
  }
  function subscribe(user, body) {
    if (!body || !Array.isArray(body.choices) || body.choices.length > 3) fail(400, '订阅结果无效')
    const allowed = new Set(Object.values(config.templates).map(t => t.id))
    for (const item of body.choices) if (!item || !allowed.has(item.templateId) || !['accept', 'reject', 'ban'].includes(item.choice)) fail(400, '订阅模板或状态无效')
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of body.choices) {
        db.prepare('INSERT INTO notification_subscriptions VALUES (?,?,?,?) ON CONFLICT(owner_id,template_id) DO UPDATE SET choice=excluded.choice,updated_at=excluded.updated_at').run(user.id, item.templateId, item.choice, stamp())
        if (item.choice === 'accept') for (const [kind, t] of Object.entries(config.templates)) if (t.id === item.templateId) {
          db.prepare("UPDATE notification_messages SET status='pending',next_at=?,error='' WHERE owner_id=? AND kind=? AND status='blocked' AND attempts<5").run(stamp(), user.id, kind)
        }
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return settings(user)
  }
  function list(user, params, admin = false) {
    if (admin && user.role !== 'admin') fail(403, '仅管理员可查看发送记录')
    scan()
    const page = Number(params.get('page') || 1), status = params.get('status') || ''
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || status && !['pending','blocked','sending','retry','failed','uncertain','sent','obsolete'].includes(status)) fail(400, '消息筛选无效')
    const where = [admin ? '1=1' : 'owner_id=?'], args = admin ? [] : [user.id]
    if (status) { where.push('status=?'); args.push(status) }
    const condition = where.join(' AND '), total = db.prepare(`SELECT COUNT(*) AS n FROM notification_messages WHERE ${condition}`).get(...args).n
    const items = db.prepare(`SELECT * FROM notification_messages WHERE ${condition} ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?`).all(...args, (page - 1) * 20).map(m => ({
      id: m.id, title: m.title, body: m.body, createdAt: m.created_at, read: !!m.read_at, status: m.status, obsolete: !current(m), appointmentId: m.appointment_id, kind: m.kind, sourceId: m.source_id,
      ...(admin ? { error: m.error, attempts: m.attempts, canRetry: ['blocked','failed','uncertain','retry'].includes(m.status) && m.attempts < 5 && !!current(m),
        history: db.prepare('SELECT attempted_at AS time,outcome,code,detail FROM notification_attempts WHERE message_id=? ORDER BY id DESC').all(m.id) } : {})
    }))
    return { items, total, page, hasMore: page * 20 < total, unread: db.prepare('SELECT COUNT(*) AS n FROM notification_messages WHERE owner_id=? AND read_at IS NULL').get(user.id).n }
  }
  function read(user, id) {
    const m = db.prepare('SELECT * FROM notification_messages WHERE id=? AND owner_id=?').get(id, user.id)
    if (!m) fail(404, '消息不存在')
    db.prepare('UPDATE notification_messages SET read_at=COALESCE(read_at,?) WHERE id=?').run(stamp(), id)
    return { read: true }
  }
  function retry(user, id) {
    if (user.role !== 'admin') fail(403, '仅管理员可重试发送')
    scan()
    const m = db.prepare('SELECT * FROM notification_messages WHERE id=?').get(id)
    if (!m) fail(404, '消息不存在')
    if (!current(m) || !['blocked','failed','uncertain','retry'].includes(m.status) || m.attempts >= 5) fail(409, '该消息已失效、正在发送或超过重试上限')
    db.prepare("UPDATE notification_messages SET status='pending',next_at=?,error='' WHERE id=?").run(stamp(), id)
    db.prepare('INSERT INTO notification_attempts (message_id,attempted_at,outcome,code,detail) VALUES (?,?,?,?,?)').run(id, stamp(), 'manual_retry', '', `管理员 ${user.id} 请求重试`)
    return { queued: true }
  }
  return { scan, tick, settings, subscribe, list, read, retry }
}
module.exports = { createNotifications }
