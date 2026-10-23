function initialize(db){
  const columns=db.prepare('PRAGMA table_info(appointments)').all()
  if(!columns.some(c=>c.name==='duration_minutes'))db.exec('ALTER TABLE appointments ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 30')
  if(!columns.some(c=>c.name==='screening_case_id'))db.exec("ALTER TABLE appointments ADD COLUMN screening_case_id TEXT NOT NULL DEFAULT ''")
  if(!columns.some(c=>c.name==='origin_article'))db.exec("ALTER TABLE appointments ADD COLUMN origin_article TEXT NOT NULL DEFAULT ''")
}
const minutes=slot=>Number(slot.slice(0,2))*60+Number(slot.slice(3))
const slotAt=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`
const blocks=duration=>Math.ceil(duration/30)
function occupied(db,doctor,date,exclude=''){
  const result=new Map()
  for(const row of db.prepare("SELECT slot,duration_minutes FROM appointments WHERE doctor=? AND date=? AND status NOT IN ('已取消','爽约') AND id<>?").all(doctor,date,exclude)){
    for(let index=0;index<blocks(row.duration_minutes);index++){const slot=slotAt(minutes(row.slot)+index*30);result.set(slot,(result.get(slot)||0)+1)}
  }
  return [...result].map(([slot,used])=>({slot,used}))
}
function remaining(db,doctor,date,start,duration,exclude=''){
  if(!/^([01]\d|2[0-3]):(00|30)$/.test(start)||minutes(start)+blocks(duration)*30>1440)return 0
  const used=occupied(db,doctor,date,exclude);let count=Infinity
  for(let index=0;index<blocks(duration);index++){
    const slot=slotAt(minutes(start)+index*30),row=db.prepare('SELECT capacity,enabled FROM schedule_slots WHERE doctor=? AND date=? AND slot=?').get(doctor,date,slot)
    if(!row||!row.enabled)return 0
    count=Math.min(count,row.capacity-(used.find(item=>item.slot===slot)?.used||0))
  }
  return Math.max(0,count)
}
function duration(catalog,service){return catalog.entries('services',true).find(row=>row.name===service)?.durationMinutes||30}
function patientConflict(db,target,date,start,duration,exclude='') {
 const from=minutes(start),to=from+blocks(duration)*30
 const rows=target.member_id ? db.prepare("SELECT slot,duration_minutes FROM appointments WHERE member_id=? AND owner_id=? AND date=? AND id<>? AND status NOT IN ('已取消','爽约')").all(target.member_id,target.owner_id,date,exclude) : db.prepare("SELECT slot,duration_minutes FROM appointments WHERE patient=? AND phone=? AND date=? AND id<>? AND status NOT IN ('已取消','爽约')").all(target.patient,target.phone,date,exclude)
 return rows.some(row=>minutes(row.slot)<to&&minutes(row.slot)+blocks(row.duration_minutes)*30>from)
}
module.exports={patientConflict,initialize,occupied,remaining,duration,minutes,blocks}
