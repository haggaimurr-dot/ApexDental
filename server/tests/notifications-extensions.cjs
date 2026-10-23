const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{createNotifications}=require('../notifications')
async function main(){const db=new DatabaseSync(':memory:');try{
 db.exec(`CREATE TABLE appointments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,date TEXT NOT NULL,slot TEXT NOT NULL,status TEXT NOT NULL,service TEXT NOT NULL,doctor TEXT NOT NULL,recall_id TEXT NOT NULL DEFAULT '',recall_node_id TEXT NOT NULL DEFAULT '',record_deleted_at TEXT NOT NULL DEFAULT '');
 CREATE TABLE events(id INTEGER PRIMARY KEY,appointment_id TEXT,to_status TEXT,created_at TEXT);
 CREATE TABLE care_tasks(id TEXT PRIMARY KEY,appointment_id TEXT,status TEXT,due_date TEXT);
 CREATE TABLE recall_plans(appointment_id TEXT PRIMARY KEY,due_date TEXT,version INTEGER);
 CREATE TABLE users(id TEXT PRIMARY KEY,subject TEXT);
 CREATE TABLE booking_rules(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE clinic_closures(id TEXT PRIMARY KEY,date TEXT,doctor TEXT,reason TEXT,enabled INTEGER,version INTEGER);
 CREATE TABLE recall_nodes(id TEXT PRIMARY KEY,appointment_id TEXT,due_date TEXT,version INTEGER);
 INSERT INTO users VALUES('patient','demo:mock-owner');
 INSERT INTO appointments(id,owner_id,date,slot,status,service,doctor) VALUES('origin','patient','2026-10-01','09:00','已完成','检查','医生');
 INSERT INTO appointments(id,owner_id,date,slot,status,service,doctor) VALUES('upcoming','patient','2026-10-11','09:00','待确认','检查','医生');
 INSERT INTO clinic_closures VALUES('closure','2026-10-11','医生','Mock停诊',1,1);
 INSERT INTO recall_nodes VALUES('node','origin','2026-10-15',1);`)
 db.prepare('INSERT INTO booking_rules VALUES(1,?)').run(JSON.stringify({reminderHour:9,recallAheadDays:7}))
 const service=createNotifications(db,{env:{},now:()=>Date.parse('2026-10-10T02:00:00Z'),fetcher:()=>{throw Error('Real network must not be used')}})
 await service.tick();assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_messages WHERE dedupe_key LIKE 'closure:%'").get().count,1);assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_messages WHERE dedupe_key LIKE 'recall-node:%'").get().count,1)
 await service.tick();assert.equal(db.prepare('SELECT COUNT(*) count FROM notification_messages').get().count,2)
 db.prepare("UPDATE clinic_closures SET enabled=0 WHERE id='closure'").run();db.prepare("INSERT INTO appointments(id,owner_id,date,slot,status,service,doctor,recall_node_id) VALUES('rebook','patient','2026-10-15','09:00','待确认','检查','医生','node')").run()
 await service.tick();assert.equal(db.prepare("SELECT status FROM notification_messages WHERE dedupe_key LIKE 'closure:%'").get().status,'obsolete');assert.equal(db.prepare("SELECT status FROM notification_messages WHERE dedupe_key LIKE 'recall-node:%'").get().status,'obsolete')
 console.log('PASS: closure notices for pending bookings, recurring-node lead reminders, deduplication, revoked closures and booked-node reminder invalidation without real network')
 }finally{db.close()}}
main().catch(error=>{console.error(error);process.exitCode=1})
