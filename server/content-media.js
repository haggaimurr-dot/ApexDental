const {randomUUID,createHash}=require('node:crypto')
const {fail,transaction,text}=require('./archive-common')
function createContentMedia(db,articles,catalog,photoTypes){
 db.exec('CREATE TABLE IF NOT EXISTS content_media(id TEXT PRIMARY KEY,kind TEXT NOT NULL,target TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,caption TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL)')
 async function upload(user,kind,id,query,req){
  const ownDoctor=user.isStaff&&user.role==='doctor'&&kind==='article'
  if(!user.isStaff||user.role!=='admin'&&!ownDoctor)fail(403,'仅管理员或文章原创医生可维护媒体')
  if(ownDoctor)articles.doctorDetail(user,id)
  if(!['article','avatar'].includes(kind))fail(400,'媒体类型无效')
  if(kind==='article'){const entry=articles.detail(user,id,true);if(entry.status==='pending')fail(409,'审核中不能编辑媒体')}
  else if(!catalog.entries('doctors',true).some(row=>row.id===id))fail(404,'医生不存在')
  const caption=text(query.get('caption')||'',200,'说明',true),chunks=[];let size=0
  for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024)fail(413,'媒体不能超过10 MB');chunks.push(chunk)}
  const bytes=Buffer.concat(chunks);let mime
  if(kind==='article'&&bytes.length>32&&bytes.subarray(4,8).toString()==='ftyp')mime='video/mp4';else mime=photoTypes.imageType(bytes)
  return transaction(db,()=>{
   if(kind==='article'&&db.prepare('SELECT status FROM articles WHERE id=?').get(id)?.status==='pending')fail(409,'审核中不能编辑媒体')
   if(kind==='article'&&db.prepare("SELECT COUNT(*) total FROM content_media WHERE kind='article' AND target=?").get(id).total>=10)fail(400,'每篇最多10份媒体')
   if(kind==='avatar')db.prepare("DELETE FROM content_media WHERE kind='avatar' AND target=?").run(id)
   const mediaId=randomUUID(),now=new Date().toISOString(),digest=createHash('sha256').update(bytes).digest('hex')
   db.prepare('INSERT INTO content_media VALUES(?,?,?,?,?,?,?,?)').run(mediaId,kind,id,mime,bytes,caption,digest,now)
   if(kind==='article'){db.prepare("UPDATE articles SET status='draft',version=version+1,editor_id=?,reviewer_id='',review_note='',updated_at=? WHERE id=?").run(user.id,now,id);db.prepare('INSERT INTO article_events(actor,entry_id,kind,after_json,created_at) VALUES(?,?,?,?,?)').run(user.id,id,'media-added',JSON.stringify({mediaId,mime,digest}),now)}
   return {media:{id:mediaId,mime,caption},...(kind==='article'?{article:articles.detail(user,id,true)}:{})}
  })
 }
 function list(kind,id){return db.prepare('SELECT id,mime,caption FROM content_media WHERE kind=? AND target=? ORDER BY created_at,id').all(kind,id)}
 function read(user,id){const row=db.prepare('SELECT * FROM content_media WHERE id=?').get(id);if(!row)fail(404,'媒体不存在');if(row.kind==='article'){const status=db.prepare('SELECT status FROM articles WHERE id=?').get(row.target)?.status;const metadata=db.prepare('SELECT metadata_json FROM articles WHERE id=?').get(row.target)?.metadata_json||'{}';const medical=user.isStaff&&(user.role==='admin'||user.role==='doctor'&&(['pending','approved','rejected'].includes(status)||JSON.parse(metadata).authorId===user.id));if(status!=='published'&&!medical)fail(404,'内容未发布')}else if(!catalog.entries('doctors').some(doctor=>doctor.id===row.target)&&!(user.isStaff&&user.role==='admin'))fail(404,'医生资料未开放');return row}
 return {upload,list,read}
}
module.exports={createContentMedia}
