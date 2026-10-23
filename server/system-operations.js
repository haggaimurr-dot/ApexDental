const fs=require('node:fs'),path=require('node:path')
const {DatabaseSync,backup}=require('node:sqlite')
const {createHash,randomUUID}=require('node:crypto')
function fail(status,message){const e=new Error(message);e.status=status;throw e}
function createSystemOperations(db,dataDir){
  const root=path.resolve(dataDir,'managed-backups');fs.mkdirSync(root,{recursive:true})
  const auditDb=new DatabaseSync(path.join(dataDir,'security-audit.sqlite'))
  auditDb.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,role TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,outcome INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'append only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'append only'); END;`)
  db.exec(`CREATE TABLE IF NOT EXISTS system_backups(id TEXT PRIMARY KEY,name TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL,verified_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS system_alerts(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT NOT NULL DEFAULT '');`)
  db.exec("CREATE TABLE IF NOT EXISTS backup_erasures(id INTEGER PRIMARY KEY,requested_at TEXT NOT NULL,processed_at TEXT NOT NULL DEFAULT '')")
  let running=false
  function admin(user){if(!user.isStaff||user.role!=='admin')fail(403,'仅管理员可查看系统运维')}
  function audit(user,url,status){auditDb.prepare('INSERT INTO audit_events(actor,role,method,path,outcome,created_at) VALUES(?,?,?,?,?,?)').run(user.id,user.role,url.method,url.pathname,status,new Date().toISOString())}
  function logs(user,params){admin(user);const page=Number(params.get('page')||1);if(!Number.isSafeInteger(page)||page<1||page>100000)fail(400,'页码无效');const total=auditDb.prepare('SELECT COUNT(*) total FROM audit_events').get().total;return {items:auditDb.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 30 OFFSET ?').all((page-1)*30).map(row=>({...row,actorName:db.prepare('SELECT display_name FROM staff WHERE user_id=?').get(row.actor)?.display_name||'患者管理账号'})),total,page,hasMore:page*30<total}}
  function alert(kind,message){const old=db.prepare("SELECT 1 FROM system_alerts WHERE kind=? AND resolved_at=''").get(kind);if(!old)db.prepare('INSERT INTO system_alerts(kind,message,created_at) VALUES(?,?,?)').run(kind,message,new Date().toISOString())}
  function status(user){admin(user);return {backups:db.prepare('SELECT * FROM system_backups ORDER BY created_at DESC').all(),alerts:db.prepare('SELECT * FROM system_alerts ORDER BY id DESC LIMIT 30').all(),configuration:{wechatLogin:!!(process.env.APEX_WECHAT_APPID&&process.env.APEX_WECHAT_SECRET),screeningProvider:!!process.env.APEX_SCREENING_URL,automaticBackup:process.env.APEX_AUTO_BACKUP==='1'},databaseIntegrity:db.prepare('PRAGMA quick_check').get().quick_check}}
  function backupPath(name){if(!/^backup-[a-f0-9-]+\.sqlite$/.test(name))fail(400,'备份标识无效');const resolved=path.resolve(root,name);if(path.dirname(resolved)!==root)fail(400,'备份路径无效');return resolved}
  async function take(user){
    admin(user);if(running)fail(409,'备份任务正在执行');running=true
    const startedAt=new Date().toISOString()
    const id=randomUUID(),name=`backup-${id}.sqlite`,destination=backupPath(name)
    try{await backup(db,destination);const copy=new DatabaseSync(destination,{readOnly:true});try{if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('备份完整性校验失败')}finally{copy.close()}
      const bytes=fs.readFileSync(destination),now=new Date().toISOString();db.prepare('INSERT INTO system_backups VALUES(?,?,?,?,?,?)').run(id,name,createHash('sha256').update(bytes).digest('hex'),bytes.length,startedAt,now);purge()
      db.prepare("UPDATE system_alerts SET resolved_at=? WHERE kind='backup' AND resolved_at=''").run(now)
      return status(user)
    }catch(e){alert('backup','备份未完成，请查看服务日志并重试');throw e}finally{running=false}
  }
  function verify(user,id){admin(user);const row=db.prepare('SELECT * FROM system_backups WHERE id=?').get(id);if(!row)fail(404,'备份不存在');const destination=backupPath(row.name);if(createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==row.digest)fail(409,'备份摘要不匹配');const copy=new DatabaseSync(destination,{readOnly:true});try{if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail(409,'备份校验失败')}finally{copy.close()}db.prepare('UPDATE system_backups SET verified_at=? WHERE id=?').run(new Date().toISOString(),id);return {verified:true,id}}
  function purge(){
    const pending=db.prepare("SELECT * FROM backup_erasures WHERE processed_at='' ORDER BY id").all()
    const retention=Number(process.env.APEX_BACKUP_RETENTION_DAYS || 30)
    if(!Number.isSafeInteger(retention)||retention<1||retention>3650)throw Error('Invalid backup retention days')
    const cutoff=new Date(Date.now()-retention*86400000).toISOString(),erase=db.prepare('SELECT MAX(requested_at) value FROM backup_erasures').get().value||''
    for(const row of db.prepare('SELECT * FROM system_backups WHERE created_at<? OR created_at<=?').all(cutoff,erase)){
      const destination=backupPath(row.name)
      if(fs.existsSync(destination)){if(fs.lstatSync(destination).isSymbolicLink())throw Error('Unexpected backup link');fs.unlinkSync(destination)}
      db.prepare('DELETE FROM system_backups WHERE id=?').run(row.id)
    }
    if(pending.length){const legacy=path.resolve(dataDir,'backups');if(fs.existsSync(legacy)){if(fs.lstatSync(legacy).isSymbolicLink())throw Error('Unexpected legacy backup link');for(const name of fs.readdirSync(legacy)){if(!/^pre-redeploy-\d{8}-\d{6}\.sqlite(?:-wal|-shm)?$/.test(name))continue;const destination=path.resolve(legacy,name);if(path.dirname(destination)!==legacy||fs.lstatSync(destination).isSymbolicLink())throw Error('Unexpected legacy backup path');if(fs.statSync(destination).mtimeMs<=Date.parse(erase))fs.unlinkSync(destination)}}}
    for(const row of pending)db.prepare('UPDATE backup_erasures SET processed_at=? WHERE id=?').run(new Date().toISOString(),row.id)
    return pending.length
  }
  async function tick(){purge();if(process.env.APEX_AUTO_BACKUP!=='1')return;const latest=db.prepare('SELECT created_at FROM system_backups ORDER BY created_at DESC LIMIT 1').get();if(!latest||Date.now()-Date.parse(latest.created_at)>86400000)await take({id:'system:backup',role:'admin',isStaff:true})}
  return {audit,logs,status,take,verify,tick,purge,alert,close:()=>auditDb.close()}
}
module.exports={createSystemOperations}
