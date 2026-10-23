function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function localDate(value) {
  if (!value) return ''
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : ''
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
function rate(count, total) { return total ? `${(count / total * 100).toFixed(1)}%` : '—' }
function createStatistics(db, doctors) {
  function summary(user, query) {
    if (!user.isStaff || !['admin', 'doctor', 'frontdesk'].includes(user.role)) fail(403, '仅诊所员工可查看运营统计')
    const from = query.get('from'), to = query.get('to'), requestedDoctor = query.get('doctor') || ''
    if (!validDate(from) || !validDate(to) || from > to) fail(400, '请选择有效的起止日期')
    const length = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1
    if (length > 90) fail(400, '单次最多统计 90 天')
    if (requestedDoctor && !doctors.includes(requestedDoctor)) fail(400, '医生不存在')
    if (user.role === 'doctor' && requestedDoctor && requestedDoctor !== user.doctorName) fail(403, '医生只能查看本人统计')
    const doctor = user.role === 'doctor' ? user.doctorName : requestedDoctor
    const where = doctor ? ' WHERE a.doctor=?' : '', args = doctor ? [doctor] : []
    const inRange = date => date && date >= from && date <= to
    const today = localDate(new Date()), generatedAt = new Date().toISOString()
    // Only aggregate columns are read. Names, contacts and clinical text never enter this response.
    const appointments = db.prepare('SELECT a.id,a.date,a.status,a.doctor,a.service,a.source,a.recall_id FROM appointments a' + where).all(...args)
    const cohort = appointments.filter(row => inRange(row.date))
    const trend = Array.from({ length }, (_, index) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10), planned: 0, arrived: 0, completed: 0 }))
    const days = new Map(trend.map(row => [row.date, row]))
    const states = ['待确认', '已预约', '取消申请中', '已到店', '已完成', '已取消', '就诊中', '爽约'].map(label => ({ label, count: cohort.filter(row => row.status === label).length }))
    for (const row of cohort) days.get(row.date).planned++
    const activity = { arrived: 0, completed: 0, cancelled: 0 }
    const seen = new Set()
    for (const row of db.prepare('SELECT e.appointment_id,e.to_status,e.created_at FROM events e JOIN appointments a ON a.id=e.appointment_id' + where).all(...args)) {
      const date = localDate(row.created_at), key = `${row.appointment_id}:${row.to_status}`
      if (!inRange(date) || seen.has(key)) continue
      seen.add(key)
      if (row.to_status === '已到店') { activity.arrived++; days.get(date).arrived++ }
      if (row.to_status === '已完成') { activity.completed++; days.get(date).completed++ }
      if (row.to_status === '已取消') activity.cancelled++
    }
    const distribution = column => [...new Set(cohort.map(row => row[column]))].map(label => ({ label, count: cohort.filter(row => row[column] === label).length })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    const arrived = cohort.filter(row => ['已到店', '就诊中', '已完成'].includes(row.status)).length
    const eligible = cohort.filter(row => row.status !== '已取消').length
    const result = { from, to, doctor: doctor || '全部医生', generatedAt, medical: user.role !== 'frontdesk',
      appointments: { total: cohort.length, arrived, completed: cohort.filter(row => row.status === '已完成').length,
        arrivalRate: rate(arrived, eligible), arrivalDenominator: eligible, states },
      activity, trend, services: distribution('service'), doctors: distribution('doctor'), care: null, recalls: null }
    if (result.medical) {
      const tasks = db.prepare(`SELECT c.id,a.service,c.due_date,c.status,c.published_at,(SELECT json_extract(p.nodes_json,'$[' || n.position || '].lossAfterDays') FROM care_plan_nodes n JOIN care_plans p ON p.id=n.plan_id WHERE n.task_id=c.id) AS loss_after,r.staff_id,f.task_id AS feedback_id,f.attention,f.created_at AS feedback_at,r.created_at AS resolved_at
        FROM care_tasks c JOIN appointments a ON a.id=c.appointment_id LEFT JOIN care_feedback f ON f.task_id=c.id LEFT JOIN care_resolutions r ON r.task_id=c.id` + where).all(...args).filter(row => row.status !== 'archived')
      const due = tasks.filter(row => row.published_at && inRange(row.due_date))
      const submitted = due.filter(row => row.feedback_id).length
      const completedTasks = due.filter(row => row.status === 'resolved').length
      const lostTask = row => {
        if (row.status !== 'published') return false
        if ((Date.parse(today) - Date.parse(row.due_date)) / 86400000 >= (row.loss_after || 7)) return true
        const recent = db.prepare("SELECT json_extract(substr(action,10),'$.outcome') AS outcome FROM care_events WHERE task_id=? AND action LIKE 'followup:%' ORDER BY id DESC LIMIT 3").all(row.id)
        return recent.length === 3 && recent.every(item => item.outcome === 'unreachable')
      }
      result.care = { lost: due.filter(lostTask).length, autoResolved: due.filter(row => row.status === 'resolved' && row.staff_id === 'system').length,
        byService: [...new Set(due.map(row => row.service))].map(service => {
          const rows = due.filter(row => row.service === service), done = rows.filter(row => row.status === 'resolved').length
          return { service, total: rows.length, completed: done, completionRate: rate(done, rows.length) }
        }), completed: completedTasks, completionRate: rate(completedTasks, due.length), due: due.length, submitted, feedbackRate: rate(submitted, due.length),
        waitingReview: due.filter(row => row.status === 'waiting_review').length,
        attention: due.filter(row => row.status === 'waiting_review' && row.attention).length,
        overdue: due.filter(row => !row.feedback_id && row.due_date < today).length,
        published: tasks.filter(row => inRange(localDate(row.published_at))).length,
        feedback: tasks.filter(row => inRange(localDate(row.feedback_at))).length,
        resolved: tasks.filter(row => inRange(localDate(row.resolved_at))).length }
      const plans = db.prepare('SELECT r.appointment_id,r.due_date,r.version FROM recall_plans r JOIN appointments a ON a.id=r.appointment_id' + where).all(...args).filter(row => inRange(row.due_date))
      let booked = 0, completed = 0, overdue = 0, lost = 0
      for (const plan of plans) {
        const linked = appointments.filter(row => row.recall_id === plan.appointment_id && row.status !== '已取消')
        if (linked.length) booked++
        if (linked.some(row => row.status === '已完成')) completed++
        if (!linked.length && plan.due_date < today) overdue++
        const recent = db.prepare('SELECT outcome FROM recall_followups WHERE appointment_id=? AND plan_version=? ORDER BY id DESC LIMIT 3').all(plan.appointment_id, plan.version)
        if (!linked.length && ((Date.parse(today) - Date.parse(plan.due_date)) / 86400000 >= 7 || recent.length === 3 && recent.every(row => row.outcome === 'unreachable'))) lost++
      }
      result.recalls = { lost, due: plans.length, booked, completed, pending: plans.length - booked, overdue, bookingRate: rate(booked, plans.length) }
    }
    result.bookingSources=distribution('source')
    result.cancellationRate=rate(cohort.filter(row=>row.status==='已取消').length,cohort.length)
    result.noShowRate=rate(cohort.filter(row=>row.status==='爽约').length,cohort.length)
    const ended=cohort.filter(row=>['已完成','爽约','已取消'].includes(row.status))
    result.finalArrivalRate=rate(ended.filter(row=>row.status==='已完成').length,ended.filter(row=>row.status!=='已取消').length)
    return result
  }
  return { summary }
}
module.exports = { createStatistics }
