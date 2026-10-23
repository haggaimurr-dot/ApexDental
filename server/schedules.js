const capacity = require('./booking-capacity')
const { randomUUID } = require('node:crypto')
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function todayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]))
  return `${values.year}-${values.month}-${values.day}`
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const day = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) return false
  const last = new Date(`${todayKey()}T00:00:00Z`)
  last.setUTCDate(last.getUTCDate() + 30)
  return value > todayKey() && value <= last.toISOString().slice(0, 10)
}
function minutes(value) {
  if (!/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value || '')) return NaN
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}
function createSchedules(db, catalog,resources) {
  capacity.initialize(db)
  const DOCTORS = { includes: name => catalog.names('doctors', true).includes(name) }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_days (doctor TEXT NOT NULL,date TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(doctor,date));
    CREATE TABLE IF NOT EXISTS schedule_slots (doctor TEXT NOT NULL,date TEXT NOT NULL,slot TEXT NOT NULL,capacity INTEGER NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(doctor,date,slot));
    CREATE TABLE IF NOT EXISTS schedule_events (id INTEGER PRIMARY KEY,actor TEXT NOT NULL,doctor TEXT NOT NULL,date TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_batches (id TEXT PRIMARY KEY,actor TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL,result TEXT);
    DROP INDEX IF EXISTS appointment_occupied_slot;
    CREATE INDEX IF NOT EXISTS appointment_slot_lookup ON appointments(date,slot,doctor,status);
  `)
  // Preserve legacy bookings when introducing explicit schedules; never reopen closed slots on restart.
  db.exec(`INSERT OR IGNORE INTO schedule_slots (doctor,date,slot,capacity,enabled)
    SELECT doctor,date,slot,COUNT(*),1 FROM appointments WHERE status<>'已取消' GROUP BY doctor,date,slot;
    INSERT OR IGNORE INTO schedule_days (doctor,date,version) SELECT DISTINCT doctor,date,0 FROM schedule_slots;`)
  function occupied(doctor,date) { return capacity.occupied(db,doctor,date) }
  function day(doctor, date) {
    const counts = occupied(doctor, date)
    const slots = db.prepare('SELECT slot,capacity,enabled FROM schedule_slots WHERE doctor=? AND date=? ORDER BY slot').all(doctor, date)
      .map(row => ({ ...row, used: counts.find(c => c.slot === row.slot)?.used || 0 }))
    return { doctor, date, version: db.prepare('SELECT version FROM schedule_days WHERE doctor=? AND date=?').get(doctor, date)?.version || 0, slots }
  }
  function availableDoctors(date, slot, service) {
    return db.prepare('SELECT doctor FROM schedule_slots WHERE date=? AND slot=? AND enabled=1 ORDER BY doctor').all(date,slot).map(row=>row.doctor).filter(name=>catalog.permits(name,service)&&capacity.remaining(db,name,date,slot,capacity.duration(catalog,service))>0&&(!resources||resources.permits(name,date,slot,capacity.duration(catalog,service),service)))
  }
  function availability(date, doctor, service) {
    const rows = doctor === '不限医生'
      ? db.prepare('SELECT * FROM schedule_slots WHERE date=?').all(date)
      : db.prepare('SELECT * FROM schedule_slots WHERE date=? AND doctor=?').all(date, doctor)
    const result = new Map()
    for (const row of rows) {
      if (!catalog.permits(row.doctor, service)) continue
      const used = occupied(row.doctor, date).find(c => c.slot === row.slot)?.used || 0
      const entry = result.get(row.slot) || { time: row.slot, remaining: 0 }
      entry.remaining += row.enabled && (!resources || resources.permits(row.doctor,date,row.slot,capacity.duration(catalog,service),service)) ? capacity.remaining(db,row.doctor,date,row.slot,capacity.duration(catalog,service)) : 0
      result.set(row.slot, entry)
    }
    return [...result.values()].sort((a, b) => a.time.localeCompare(b.time)).map(row => ({ ...row, disabled: row.remaining === 0 }))
  }
  function save(user, body) {
    const { doctor, date, start, end, capacity, enabled, version } = body
    const from = minutes(start), to = minutes(end)
    if (!DOCTORS.includes(doctor) || !validDate(date)) fail(400, '医生或排班日期无效')
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 720) fail(400, '请选择有效的半小时时段，单次范围不超过 12 小时')
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10 || typeof enabled !== 'boolean' || !Number.isInteger(version)) fail(400, '容量应为 1–10 人，请重新加载排班后保存')
    if (enabled && !catalog.permits(doctor)) fail(409, '医生已停用，不能开放新号源')
    const times = []
    for (let m = from; m < to; m += 30) times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = day(doctor, date)
      if (previous.version !== version) fail(409, '排班已被修改，请重新加载后再保存')
      for (const count of occupied(doctor, date)) {
        if (!times.includes(count.slot)) fail(409, `${count.slot} 已有预约，不能移除该时段`)
        if (capacity < count.used) fail(409, `${count.slot} 已占用 ${count.used} 个号源，容量不能低于该数量`)
      }
      db.prepare('DELETE FROM schedule_slots WHERE doctor=? AND date=?').run(doctor, date)
      const insert = db.prepare('INSERT INTO schedule_slots VALUES (?,?,?,?,?)')
      for (const time of times) insert.run(doctor, date, time, capacity, Number(enabled))
      db.prepare('INSERT INTO schedule_days VALUES (?,?,?) ON CONFLICT(doctor,date) DO UPDATE SET version=excluded.version').run(doctor, date, version + 1)
      db.prepare('INSERT INTO schedule_events (actor,doctor,date,details,created_at) VALUES (?,?,?,?,?)').run(user.id, doctor, date, JSON.stringify({ before: previous, after: { start, end, capacity, enabled } }), new Date().toISOString())
      db.exec('COMMIT')
      return day(doctor, date)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function requireAdmin(user) { if (user.role !== 'admin') fail(403, '仅管理员可批量配置排班') }
  function configuration(schedule) { return schedule.slots.map(({ slot,capacity,enabled }) => ({ slot,capacity,enabled })) }
  function conflicts(doctor,date,slots) {
    for (const count of occupied(doctor,date)) {
      const slot = slots.find(row => row.slot === count.slot)
      if (!slot) return `${count.slot} 已有预约，不能移除该时段`
      if (slot.capacity < count.used) return `${count.slot} 已占用 ${count.used} 个号源，来源容量不足`
    }
    return ''
  }
  function previewBatch(user,body) {
    requireAdmin(user)
    const { sourceDoctor,sourceDate,sourceVersion,targets,mode } = body
    if (!DOCTORS.includes(sourceDoctor) || !validDate(sourceDate) || !Number.isSafeInteger(sourceVersion) || !['copy','open'].includes(mode)) fail(400,'请重新加载来源排班并选择复制方式')
    if (!Array.isArray(targets) || !targets.length || targets.length > 30) fail(400,'请选择 1–30 个目标排班')
    const keys = new Set()
    for (const target of targets) {
      if (!target || !DOCTORS.includes(target.doctor) || !validDate(target.date)) fail(400,'目标医生或日期无效')
      const key = `${target.doctor}:${target.date}`
      if (keys.has(key) || target.doctor === sourceDoctor && target.date === sourceDate) fail(400,'目标不能重复或包含来源排班')
      keys.add(key)
    }
    if (targets.some(target => !catalog.permits(target.doctor))) fail(409, '目标医生已停用，请重新选择')
    const source = day(sourceDoctor,sourceDate)
    if (source.version !== sourceVersion) fail(409,'来源排班已更新，请重新加载后预览')
    if (!source.slots.length) fail(409,'来源日期尚无排班，请先保存排班')
    const sourceSlots = configuration(source)
    if (sourceSlots.some(row => !Number.isFinite(minutes(row.slot)) || !Number.isInteger(row.capacity) || row.capacity < 1 || row.capacity > 10 || ![0,1].includes(row.enabled))) fail(409,'来源排班配置无效，请先重新保存')
    const slots = sourceSlots.map(row => ({ ...row,enabled: mode === 'open' ? 1 : row.enabled }))
    const rows = targets.map(target => {
      const current = day(target.doctor,target.date), problem = conflicts(target.doctor,target.date,slots)
      const counts = occupied(target.doctor,target.date)
      const used = counts.reduce((total,row) => total + row.used,0)
      return { doctor: target.doctor,date: target.date,version: current.version,existing: current.slots.length > 0,
        used,problem,remaining: problem ? 0 : slots.reduce((total,row) => total + (row.enabled ? Math.max(0,row.capacity - (counts.find(count => count.slot === row.slot)?.used || 0)) : 0),0) }
    })
    const id = `SB-${randomUUID()}`, expiresAt = new Date(Date.now() + 10 * 60000).toISOString()
    const payload = { sourceDoctor,sourceDate,sourceVersion,sourceSlots,slots,targets: rows,mode }
    db.prepare('INSERT INTO schedule_batches VALUES (?,?,?,?,NULL)').run(id,user.id,JSON.stringify(payload),expiresAt)
    db.prepare('DELETE FROM schedule_batches WHERE expires_at<? AND result IS NULL').run(new Date().toISOString())
    return { id,sourceDoctor,sourceDate,mode,slots,targets: rows,canCommit: rows.every(row => !row.problem),expiresAt }
  }
  function commitBatch(user,body) {
    requireAdmin(user)
    if (typeof body.previewId !== 'string' || body.previewId.length > 100) fail(400,'请先预览复制结果')
    db.exec('BEGIN IMMEDIATE')
    try {
      const batch = db.prepare('SELECT * FROM schedule_batches WHERE id=? AND actor=?').get(body.previewId,user.id)
      if (!batch) fail(404,'排班预览不存在，请重新预览')
      if (batch.result) { const result = JSON.parse(batch.result); db.exec('COMMIT'); return result }
      if (batch.expires_at < new Date().toISOString()) fail(409,'预览已过期，请重新预览')
      const payload = JSON.parse(batch.payload), source = day(payload.sourceDoctor,payload.sourceDate)
      if (!validDate(payload.sourceDate) || source.version !== payload.sourceVersion || JSON.stringify(configuration(source)) !== JSON.stringify(payload.sourceSlots)) fail(409,'来源排班已变更，请重新加载并预览')
      for (const target of payload.targets) {
        if (!catalog.permits(target.doctor)) fail(409, '目标医生已停用，请重新预览')
        if (!validDate(target.date) || day(target.doctor,target.date).version !== target.version) fail(409,`${target.doctor} ${target.date} 排班已变更，请重新预览`)
        const problem = conflicts(target.doctor,target.date,payload.slots)
        if (problem) fail(409,`${target.doctor} ${target.date}：${problem}`)
      }
      const timestamp = new Date().toISOString()
      for (const target of payload.targets) {
        const before = day(target.doctor,target.date)
        db.prepare('DELETE FROM schedule_slots WHERE doctor=? AND date=?').run(target.doctor,target.date)
        for (const slot of payload.slots) db.prepare('INSERT INTO schedule_slots VALUES (?,?,?,?,?)').run(target.doctor,target.date,slot.slot,slot.capacity,slot.enabled)
        db.prepare('INSERT INTO schedule_days VALUES (?,?,?) ON CONFLICT(doctor,date) DO UPDATE SET version=excluded.version').run(target.doctor,target.date,target.version + 1)
        db.prepare('INSERT INTO schedule_events (actor,doctor,date,details,created_at) VALUES (?,?,?,?,?)').run(user.id,target.doctor,target.date,JSON.stringify({ batchId: batch.id,sourceDoctor: payload.sourceDoctor,sourceDate: payload.sourceDate,mode: payload.mode,before,after: payload.slots }),timestamp)
      }
      const result = { id: batch.id,count: payload.targets.length,mode: payload.mode }
      db.prepare('UPDATE schedule_batches SET result=? WHERE id=?').run(JSON.stringify(result),batch.id)
      db.exec('COMMIT'); return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { day, availability, availableDoctors, save,previewBatch,commitBatch }
}
module.exports = { createSchedules, validDate }
