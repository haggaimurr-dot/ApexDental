// Workflow dates are editable scheduling suggestions, anchored to the treatment date.
const workflows = [
  { id: 'cleaning', name: '洁牙', match: '洁牙', stages: [['当日护理', 0], ['恢复反馈', 3], ['第七天护理', 7], ['护理习惯回访', 30], ['长期复查准备', 180]] },
  { id: 'extraction', name: '拔牙', match: '拔牙', stages: [['术后反馈', 1], ['恢复观察', 3], ['复诊准备', 7]] },
  { id: 'orthodontics', name: '正畸', match: '正畸', stages: [['佩戴适应', 1], ['口腔清洁反馈', 7], ['阶段照片', 14], ['复诊准备', 30]] },
  { id: 'implant', name: '种植', match: '种植', stages: [['术后反馈', 1], ['医生护理与用药提示', 3], ['恢复观察', 7], ['阶段照片', 14], ['复诊准备', 30], ['长期维护回访', 180]] }
]
function buildWorkflow(id, anchorDate) {
  const workflow = workflows.find(item => item.id === id)
  if (!workflow) return []
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  return workflow.stages.map(([phase, days]) => ({ title: `${workflow.name} · ${phase}`, phase,
    instructions: `请按接诊医生提供的护理说明执行，并在本阶段提交恢复反馈。${phase === '阶段照片' ? '可附上本阶段照片供医生查看。' : ''}`,
    dueDate: new Date(Math.max(Date.parse(`${anchorDate}T00:00:00Z`) + days * 86400000, Date.parse(`${today}T00:00:00Z`))).toISOString().slice(0, 10),
    autoNormal: false, lossAfterDays: 7, followupIntervalDays: 3 }))
}
module.exports = { workflows, buildWorkflow }
