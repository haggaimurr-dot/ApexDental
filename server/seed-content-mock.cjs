// Explicit, repeatable demo import. Never runs on normal server startup.
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const { createCatalog } = require('./catalog')
const { createArticles } = require('./articles')
const db = new DatabaseSync(process.env.APEX_DB_PATH || path.join(__dirname, 'data', 'apex-demo.sqlite'))
try {
  const catalog = createCatalog(db), articles = createArticles(db, catalog)
  const actor = { id: 'mock-import', role: 'admin', isStaff: true }
  const clinic=catalog.list(actor,true).clinic
  if(clinic.version===1&&!clinic.phone&&!clinic.address&&!clinic.introduction)catalog.save(actor,'clinic',{...clinic,address:'Mock地址：示例市示例路100号（非真实门店地址）',hours:'Mock营业时间：09:00–18:00，实际安排由诊所填写',introduction:'【Mock诊所资料】ApexDental为本项目的诊所演示名称。本环境展示口腔知识、预约、护理与健康档案流程；地址、营业时间和医生介绍均需由真实诊所提供资料后替换，未提供真实联系电话。'})
  for(const service of catalog.entries('services',true))if(service.version===1&&!service.introduction&&!service.preparation)catalog.save(actor,'services',{...service,introduction:`【Mock项目说明】${service.name}用于演示项目资料、医生范围与预约入口。项目实际内容和适用条件由接诊医生说明。`,preparation:'【Mock预约准备】可整理已有检查资料和希望咨询的问题；具体准备事项由诊所确认。'},service.id)
  for(const doctor of catalog.entries('doctors',true))if(doctor.version===1&&!doctor.introduction&&!doctor.license)catalog.save(actor,'doctors',{...doctor,title:'Mock演示医生',license:'Mock：无真实执业核验资料',specialties:'Mock：演示口腔检查及日常咨询入口',introduction:`【Mock演示医生】${doctor.name}为系统初始示例名称，本介绍不代表真实履历或资质。实际医生资料由诊所提供、核验后录入。`},doctor.id)
  const doctors = [
    { name: '林医生（Mock）', title: '演示医生', license: 'Mock：非真实执业资料', specialties: '演示关联：儿童口腔检查、日常清洁咨询', introduction: '【Mock 演示资料】林医生为虚构人物，用于展示儿童与家庭口腔咨询页面。示例接诊沟通包括了解家长关注的问题、说明检查流程、记录需要由真实医生评估的事项。此简介不代表真实履历、资质或诊疗承诺。', serviceNames: ['儿童口腔检查', '初次口腔检查'] },
    { name: '陈医生（Mock）', title: '演示医生', license: 'Mock：非真实执业资料', specialties: '演示关联：成人口腔检查、洁牙护理咨询', introduction: '【Mock 演示资料】陈医生为虚构人物，用于展示成人及中老年咨询页面。示例介绍强调沟通就诊目标、整理既往口腔治疗信息和解释项目准备事项。真实诊疗范围、医生资质与治疗方案须以诊所核验资料为准。', serviceNames: ['初次口腔检查', '洁牙护理', '牙齿不适咨询'] }
  ]
  for (const doctor of doctors) if (!catalog.names('doctors', true).includes(doctor.name)) catalog.save(actor, 'doctors', { ...doctor, enabled: true })
  const rows = [
    ['children', '儿童口腔检查：家长如何准备', '儿童口腔检查', ['林医生（Mock）'], '检查前可以整理孩子的主要困扰、开始时间、既往看牙经历及正在使用的药物，便于现场沟通。', '乳牙、换牙、龋齿、涂氟和窝沟封闭可作为咨询话题。是否适合某项处理须由接诊医生检查评估。', []],
    ['teenagers', '青少年牙列与正畸咨询：先整理问题', '初次口腔检查', ['林医生（Mock）'], '希望了解牙列、正畸或智齿时，可以记录最关注的变化和咨询目标，并携带已有检查资料。', '本篇仅演示咨询准备流程。矫治方式、开始时机和是否需要进一步检查，由真实医生评估后说明。', []],
    ['adults', '成人口腔健康：日常清洁与检查沟通', '洁牙护理', ['陈医生（Mock）'], '含氟牙膏刷牙、清洁牙齿间隙以及减少含糖饮食，是日常口腔卫生话题。具体清洁方法可向接诊医生咨询。', '检查时可以提出洗牙、补牙、牙周、根管或正畸方面的问题。项目选择与复查安排应基于实际检查结果。', []],
    ['seniors', '中老年口腔咨询：缺牙与日常照护', '初次口腔检查', ['陈医生（Mock）'], '就诊前整理现有义齿使用情况、咀嚼困扰、既往治疗及用药清单，有助于与医生沟通。', '缺牙、松动、牙周、种植和义齿可作为咨询主题。年龄本身不决定治疗方案，需要结合实际情况评估。', []],
    ['adults', '牙龈出血时，怎样向医生描述', '牙齿不适咨询', ['陈医生（Mock）'], '记录出血出现的场景、持续时间及伴随变化，检查时向医生说明，不依据文章自行判定原因。', '日常清洁仍需关注方法；是否存在牙龈或牙周问题，需要现场评估。请通过诊所联系方式咨询就诊安排。', ['bleeding']],
    ['adults', '洁牙咨询前后：记录医生的个别要求', '洁牙护理', ['陈医生（Mock）'], '预约前说明最关注的问题、既往治疗经历及现有用药，具体准备事项以诊所提供的信息为准。', '完成接诊后，保存医生针对个人情况提供的清洁、观察及复查要求。如有疑问，通过诊所联系渠道询问。', []]
  ]
  rows.push(['adults','认识龋齿：检查时可以问什么','初次口腔检查',['陈医生（Mock）'],'龋齿与牙菌斑中的细菌产生酸、损伤牙齿硬组织有关。此处只演示百科结构。','检查结果、处理方式及适用条件由真实接诊医生说明；本例不提供个人诊断或治疗方案。',[]],['children','儿童口腔检查：项目百科示例','儿童口腔检查',['林医生（Mock）'],'本篇展示项目说明、就诊准备与常见问题的内容结构。','本例中的项目范围和说明需由诊所核对；真实项目细节以接诊安排为准。',[]])
  rows.forEach(([population, title, service, doctorNames, preparation, topics, symptoms], index) => {
    const id = `mock-content-${index + 1}`
    if (db.prepare('SELECT 1 FROM articles WHERE id=?').get(id)) return
    const now = new Date().toISOString()
    const body = `【Mock 演示文章｜未经过真实诊所审核】\n\n这篇内容用于验证人群分类、医生关联、项目预约与独立审核流程，不能作为诊所正式发布稿。\n\n就诊前的沟通准备\n${preparation}\n\n可以咨询的话题\n${topics}\n\n页面与后续安排\n可在本页查看关联医生介绍与服务项目。预约日期以实际号源为准；咨询后按接诊医生给出的要求执行。\n\n参考资料：NIDCR Oral Hygiene（https://www.nidcr.nih.gov/health-info/oral-hygiene）。本示例需由诊所核对并替换后再作为正式内容发布。`
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO articles (id,title,summary,body,category_id,service,status,version,published_at,updated_at,symptoms_json,populations_json,doctors_json,editor_id) VALUES (?,?,?,?,?,?,'draft',1,NULL,?,?,?,?,?)`).run(id, `【Mock】${title}`, '演示内容：咨询准备、常见沟通话题及关联医生和项目，等待诊所审核替换。', body, index === 5 ? 'treatment' : 'daily-care', service, now, JSON.stringify(symptoms), JSON.stringify([population]), JSON.stringify(doctorNames), actor.id)
      db.prepare('UPDATE articles SET metadata_json=? WHERE id=?').run(JSON.stringify({kind:index===6?'disease':index===7?'service':'article',definition:index===6?'Mock：龋齿涉及牙齿硬组织的损伤，需通过口腔检查评估。':index===7?'Mock：儿童口腔检查用于沟通家长关注的问题及检查准备。':'',preparation:preparation,consultation:topics,faq:[{question:'这篇内容是否为诊所正式审核稿？',answer:'不是。本篇是Mock演示资料，需诊所核对、替换后完成独立审核。'}],references:[{title:index===6?'NIDCR Tooth Decay':'NIDCR Oral Hygiene',url:index===6?'https://www.nidcr.nih.gov/health-info/tooth-decay':'https://www.nidcr.nih.gov/health-info/oral-hygiene'}],featured:false,blocks:[],authorId:''}),id)
      db.prepare('INSERT INTO article_events (actor,entry_id,kind,before_json,after_json,created_at) VALUES (?,?,?,NULL,?,?)').run(actor.id, id, 'mock-import', JSON.stringify({ id, title, status: 'draft', mock: true }), now)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  })
  console.log('Mock import complete: 8 article drafts, 2 added fictional doctors, and blank initial profiles filled with labeled Mock data; maintained content preserved.')
} finally { db.close() }
