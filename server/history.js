function createHistory(db, visits, recalls,sharing) {
  function detail(user, id, scope) {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
    function fail(status, message) { const error = new Error(message); error.status = status; throw error }
    if (!appointment) fail(404, '记录不存在')
    const clinic = scope === 'clinic'
    if (clinic) {
      if (!['admin', 'doctor'].includes(user.role)) fail(403, '当前角色不能查看健康档案')
      if (user.role === 'doctor' && appointment.doctor !== user.doctorName) fail(403, '只能查看本人接诊的档案')
    } else if (!sharing.canRead(user,appointment)) fail(403, '无权查看此记录')
    if (appointment.record_deleted_at) fail(410, '该次健康档案已删除')
    const titles = { '待确认': '提交预约', '已预约': '预约已确认', '已到店': '已到店', '已完成': '接诊完成', '取消申请中': '申请取消预约', '已取消': '预约已取消' }
    const entries = db.prepare('SELECT * FROM events WHERE appointment_id=? ORDER BY id').all(id).map(event => ({
      id: `appointment-${event.id}`, type: event.to_status === '已完成' || event.to_status === '已到店' ? 'visit' : 'appointment',
      title: event.to_status === '已预约' && event.from_status === '取消申请中' ? '保留原预约' : titles[event.to_status] || event.to_status,
      at: event.created_at, text: `${appointment.service} · ${appointment.doctor}`, taskId: ''
    }))
    if (clinic) for (const event of db.prepare('SELECT * FROM appointment_confirmations WHERE appointment_id=? ORDER BY id').all(id)) entries.push({
      id: `confirmation-${event.id}`, type: 'appointment', title: '预约确认沟通记录', at: event.created_at,
      text: `确认时段：${event.date} ${event.slot}\n操作人：${event.actor_name}（${event.actor_role === 'admin' ? '管理员' : '前台'}）\n沟通说明：${event.note}`, taskId: ''
    })
    const summaries = visits.revisions(id)
    for (const event of db.prepare('SELECT * FROM appointment_reschedules WHERE appointment_id=? ORDER BY id').all(id)) entries.push({
      id: `reschedule-${event.id}`, type: 'appointment', title: '预约改期 · 重新待确认', at: event.created_at,
      text: `原时间：${event.old_date} ${event.old_slot}（${event.old_status}）\n新时间：${event.new_date} ${event.new_slot}\n操作人：${event.actor_name}\n原因：${event.reason}`, taskId: ''
    })
    const recall = recalls.get(id)
    if (recall) recall.mayManage = appointment.owner_id === user.id
    const previousAppointmentId = appointment.recall_id || ''
    if (clinic) for (const followup of db.prepare('SELECT * FROM recall_followups WHERE appointment_id=? ORDER BY id').all(id)) entries.push({
      id: `recall-followup-${followup.id}`, type: 'recall', title: '内部复查跟进记录', at: followup.created_at,
      text: `${followup.note}\n再次跟进日期：${followup.next_contact_date}`, taskId: ''
    })
    for (const event of db.prepare('SELECT * FROM recall_events WHERE appointment_id=? ORDER BY id').all(id)) entries.push({
      id: `recall-${event.id}`, type: 'recall', title: `复查安排 · 第 ${event.version} 版`, at: event.created_at,
      text: `建议复查日期：${event.due_date}\n${event.instructions}`, taskId: ''
    })
    for (const booking of db.prepare('SELECT * FROM appointments WHERE recall_id=? ORDER BY created_at').all(id)) {
      const original = db.prepare('SELECT old_date AS date,old_slot AS slot FROM appointment_reschedules WHERE appointment_id=? ORDER BY id LIMIT 1').get(booking.id) || booking
      entries.push({
        id: `recall-booking-${booking.id}`, type: 'appointment', title: '患者提交复查预约', at: booking.created_at,
        text: `${original.date} ${original.slot} · ${booking.doctor}`, relatedAppointmentId: booking.id, taskId: ''
      })
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='treatment_stages'").get())for(const stage of db.prepare('SELECT * FROM treatment_stages WHERE appointment_id=?').all(id))entries.push({id:`stage-${stage.id}`,type:'stage',title:`治疗阶段 · ${stage.title}`,at:stage.created_at,text:`${stage.status} · ${stage.due_date}\n${stage.note}`,taskId:''})
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='summary_acknowledgments'").get())for(const signature of db.prepare('SELECT summary_version,name,created_at FROM summary_acknowledgments WHERE appointment_id=?').all(id))entries.push({id:`signature-${id}-${signature.summary_version}`,type:'signature',title:`小结第 ${signature.summary_version} 版已签署确认`,at:signature.created_at,text:`记录作者：${signature.name}`,taskId:''})
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_messages'").get())for(const message of db.prepare("SELECT id,title,body,created_at,status FROM notification_messages WHERE appointment_id=? AND status<>'obsolete'").all(id))entries.push({id:`reminder-${message.id}`,type:'reminder',title:message.title,at:message.created_at,text:`${message.body}\n${message.status==='sent'?'微信提醒已发送':'站内提醒可查看'}`,taskId:''})
    if(appointment.screening_case_id&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='screening_cases'").get()){const result=db.prepare("SELECT id,review_json FROM screening_cases WHERE id=? AND status='reviewed'").get(appointment.screening_case_id);if(result){const review=JSON.parse(result.review_json);entries.push({id:`screening-${result.id}`,type:'screening',title:'口腔初筛 · 医生复核',at:review.reviewedAt,text:`${review.reviewerName}\n${review.opinion}`,taskId:''})}}
    const summary = summaries.length ? summaries[summaries.length - 1] : null
    for (const revision of summaries) entries.push({ id: `summary-${id}-${revision.version}`, type: 'summary',
      title: `就诊小结 · 第 ${revision.version} 版${revision.version === summary.version ? '（当前）' : '（已更新）'}`,
      at: revision.savedAt, text: `记录人：${revision.authorName}\n检查结果：${revision.findings}\n处置说明：${revision.treatment}\n后续安排：${revision.nextSteps}`, taskId: '' })
    for (const photo of db.prepare('SELECT id,category,caption,created_at FROM record_photos WHERE appointment_id=?').all(id)) entries.push({ id: `photo-${photo.id}`, type: 'photo', title: `照片归档 · ${photo.category}`, at: photo.created_at, text: photo.caption, taskId: '' })
    for (const file of db.prepare('SELECT id,kind,name,tooth,created_at FROM record_attachments WHERE appointment_id=?').all(id)) entries.push({id:`attachment-${file.id}`,type:'attachment',title:`附件归档 · ${file.kind}`,at:file.created_at,text:`${file.name}${file.tooth ? ' · 牙位 '+file.tooth : ''}`,taskId:''})
    for (const entry of entries) if (entry.type === 'summary') {
      const revision = summaries.find(row => entry.id === `summary-${id}-${row.version}`)
      const structured = revision.structured || {}
      if (structured.diagnosis) entry.text += `\n诊断：${structured.diagnosis}`
      if (structured.teeth?.length) entry.text += `\n牙位：${structured.teeth.join('、')}`
      if (structured.procedure) entry.text += `\n治疗项目：${structured.procedure}`
      if (structured.materials) entry.text += `\n材料：${structured.materials}`
    }
    const tasks = db.prepare("SELECT * FROM care_tasks WHERE appointment_id=? AND status<>'archived' ORDER BY created_at,id").all(id)
    for (const task of tasks) {
      if (task.status === 'draft') {
        if (clinic) entries.push({ id: `${task.id}-draft`, type: 'care', title: '护理草稿待编写', at: task.created_at, text: task.title, taskId: task.id, taskStatus: task.status })
        continue
      }
      if (task.published_at) entries.push({ id: `${task.id}-published`, type: 'care', title: '护理任务已发送', at: task.published_at,
        text: `${task.title}\n反馈日期：${task.due_date}\n${task.instructions}`, taskId: task.id, taskStatus: task.status })
      if (clinic) for (const contact of db.prepare("SELECT id,action,created_at FROM care_events WHERE task_id=? AND action LIKE 'followup:%' ORDER BY id").all(task.id)) {
        const value = JSON.parse(contact.action.slice(9))
        entries.push({ id: `care-contact-${contact.id}`, type: 'care', title: '内部护理跟进', at: contact.created_at,
          text: `${value.outcome === 'unreachable' ? '无法联系' : value.outcome === 'declined' ? '暂不反馈' : '已联系'}：${value.note}\n再次联系：${value.nextContactDate}`, taskId: task.id, taskStatus: task.status })
      }
      const feedback = db.prepare('SELECT * FROM care_feedback WHERE task_id=?').get(task.id)
      const photoCount = feedback ? db.prepare('SELECT COUNT(*) AS total FROM care_photos WHERE task_id=? AND attached=1').get(task.id).total : 0
      if (feedback) entries.push({ id: `${task.id}-feedback`, type: 'feedback', title: '患者恢复反馈', at: feedback.created_at,
        text: `${task.title}\n不适情况：${feedback.pain}\n出血：${feedback.bleeding ? '有' : '无'} · 肿胀：${feedback.swelling ? '有' : '无'}${feedback.note ? '\n' + feedback.note : ''}${photoCount ? '\n附恢复照片 ' + photoCount + ' 张，可在护理详情查看' : ''}`,
        taskId: task.id, taskStatus: task.status })
      const resolution = db.prepare('SELECT * FROM care_resolutions WHERE task_id=?').get(task.id)
      if (resolution) entries.push({ id: `${task.id}-resolved`, type: 'resolution', title: resolution.staff_id === 'system' ? '正常反馈自动随访' : '诊所处理意见', at: resolution.created_at,
        text: `${task.title}\n${resolution.note}`, taskId: task.id, taskStatus: task.status })
    }
    // Existing records without status events remain identifiable without inventing visit times.
    entries.sort((a, b) => a.at.localeCompare(b.at))
    return { appointment: { id: appointment.id, mayManage: appointment.owner_id === user.id,
      canReschedule: ['待确认', '已预约'].includes(appointment.status) && (clinic ? user.role === 'admin' : appointment.owner_id === user.id),
      memberId: appointment.member_id || '', patient: appointment.patient, doctor: appointment.doctor,
      service: appointment.service, date: appointment.date, slot: appointment.slot, status: appointment.status }, summary, recall, previousAppointmentId, entries }
  }
  return { detail }
}
module.exports = { createHistory }
