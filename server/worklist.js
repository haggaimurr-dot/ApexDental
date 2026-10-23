function createWorklist(db, care, recalls) {
  function list(user) {
    if (!user.isStaff) { const error = new Error('仅诊所员工可查看待办'); error.status = 403; throw error }
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const items = [], medical = ['admin', 'doctor'].includes(user.role)
    const appointments = user.role === 'doctor'
      ? db.prepare('SELECT * FROM appointments WHERE doctor=?').all(user.doctorName)
      : db.prepare('SELECT * FROM appointments').all()
    for (const row of appointments) {
      let title = '', actions = [], priority = 4, label = '待处理'
      if (user.role !== 'doctor') {
        if (row.status === '待确认') { title = '确认预约申请'; actions = [{ status: '已预约', label: '确认预约' }, { status: '已取消', label: '拒绝预约' }] }
        if (row.status === '取消申请中') { title = '处理取消申请'; priority = 1; actions = [{ status: '已取消', label: '同意取消' }, { status: '已预约', label: '保留预约' }] }
        if (row.status === '已预约' && row.date <= today) {
          title = row.date < today ? '核实未到店预约' : '今日待到店'; priority = row.date < today ? 2 : 5
          label = row.date < today ? '已过预约日期' : '今日'
          actions = [{ status: '已到店', label: '标记到店' }];if(Date.parse(`${row.date}T${row.slot}:00+08:00`)<Date.now())actions.push({status:'爽约',label:'核实后标记爽约'})
        }
      }
      if (medical && ['已到店','就诊中'].includes(row.status)) { title = '完成接诊'; priority = 3; actions = row.status==='已到店'?[{status:'就诊中',label:'开始接诊'},{status:'已完成',label:'完成接诊'}]:[{status:'已完成',label:'完成接诊'}] }
      if (medical && !row.record_deleted_at && row.status === '已完成' && !db.prepare('SELECT 1 FROM visit_summaries WHERE appointment_id=?').get(row.id)) {
        title = '补充就诊小结'; priority = 6
      }
      if (title) items.push({ id: `appointment:${row.id}`, group: 'appointment', title, patient: row.patient,
        doctor: row.doctor, phone: row.phone, description: `${row.service} · ${row.date} ${row.slot} · ${row.status}`,
        appointmentId: row.id, appointmentStatus: row.status, version: row.booking_version, dueDate: row.date, filterDate: row.date,
        actionable: true, overdue: row.status === '已预约' && row.date < today, state: 'appointment', priority, priorityLabel: label,
        action: actions.length ? 'status' : 'history', actions })
    }
    if (medical) {
      for (const task of care.list(user, 'clinic')) {
        if (task.status === 'resolved') continue
        const triageOverdue=task.triage&&task.status==='waiting_review'&&task.triage.deadline<new Date().toISOString()
        const attention = task.status === 'waiting_review' && task.feedback && task.feedback.attention
        const overdue = task.status === 'published' && task.dueDate < today
        const deferred = overdue && task.nextContactDate > today
        items.push({ id: `care:${task.id}`, group: 'care', title: task.status==='scheduled'?'护理节点待按日期或阶段发送':task.status==='paused'?'护理节点已暂停':task.status === 'draft' ? '编写护理任务' : task.status === 'waiting_review' ? '处理护理反馈' : task.followupState === 'lost' ? '失访护理需跟进' : '护理反馈未提交',
          patient: task.patient, doctor: task.doctor, phone: db.prepare('SELECT phone FROM appointments WHERE id=?').get(task.appointmentId).phone,
          description: `${task.title} · 反馈日期 ${task.dueDate}${task.nextContactDate ? ' · 再次联系 ' + task.nextContactDate : ''}`,
          appointmentId: task.appointmentId, taskId: task.id, dueDate: task.dueDate, filterDate: task.dueDate,
          hasPhotos:!!task.feedback?.photos?.length,triage:task.triage?{priority:task.triage.priority,destination:triageOverdue?'admin':task.triage.destination,deadline:task.triage.deadline}:null,state: task.status, followupState: task.followupState, deferred, actionable: ['draft','waiting_review'].includes(task.status) || task.status==='published' && overdue && !deferred, overdue,
          priority: triageOverdue||task.triage?.priority==='urgent'?0:attention ? 0 : task.status === 'waiting_review' ? 2 : overdue ? 3 : task.status === 'draft' ? 6 : 7,
          priorityLabel: triageOverdue?'处理超时，升级管理员':task.triage?.priority==='urgent'?'人工标记紧急':task.status==='scheduled'?'待发送':task.status==='paused'?'已暂停':deferred ? '暂缓跟进' : task.followupState === 'lost' ? '失访' : attention ? '需关注' : overdue ? '已过反馈日期' : task.status === 'published' ? '待反馈' : '待处理',
          action: task.status === 'draft' ? 'care-edit' : 'care-review', actions: [] })
      }
      for (const plan of recalls.list(user, 'clinic')) {
        if (plan.status !== 'pending') continue
        const followup = recalls.followup(plan.appointmentId, plan.version)
        const deferred = Boolean(plan.overdue && followup && followup.nextContactDate > today)
        items.push({ id: `recall:${plan.appointmentId}`, group: 'recall', title: deferred ? '复查已安排再次跟进' : plan.followupState === 'lost' ? '失访复查需跟进' : plan.overdue ? '跟进逾期复查' : '复查待预约', patient: plan.patient, doctor: plan.doctor,
          phone: db.prepare('SELECT phone FROM appointments WHERE id=?').get(plan.appointmentId).phone,
          description: `建议复查日期 ${plan.dueDate}${followup ? ' · 再次跟进日期 ' + followup.nextContactDate : ' · 尚未预约'}`,
          appointmentId: plan.appointmentId, recallVersion: plan.version, dueDate: followup ? followup.nextContactDate : plan.dueDate,
          filterDate: plan.dueDate, state: 'recall_pending', followupState: plan.followupState, actionable: plan.overdue && !deferred, overdue: plan.overdue, deferred,
          priority: plan.overdue && !deferred ? 2 : 7, priorityLabel: deferred ? '暂缓跟进' : plan.followupState === 'lost' ? '失访' : plan.overdue ? '已逾期' : '待预约',
          action: plan.overdue && !deferred ? 'recall-followup' : 'history', actions: [], followup })
      }
    }
    items.sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
    const counts = { all: 0, appointment: 0, care: 0, recall: 0, attention: 0, tracked: items.length }
    for (const item of items) { if (!item.actionable) continue; counts.all++; counts[item.group]++; if (item.priority === 0) counts.attention++ }
    return { items, counts, date: today, generatedAt: new Date().toISOString() }
  }
  return { list }
}
module.exports = { createWorklist }
