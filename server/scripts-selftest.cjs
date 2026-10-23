const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
const root=path.resolve(__dirname),report={checkedAt:new Date().toISOString(),node:process.version,checks:[],realDeviceTested:false}
async function run(label,args,cwd=root,executable=process.execPath){return new Promise(resolve=>{const child=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>child.kill(),90000);child.on('error',error=>{clearTimeout(timer);resolve({label,passed:false,output:error.message})});child.on('close',code=>{clearTimeout(timer);resolve({label,passed:code===0,output:output.trim().slice(-4000)})})})}
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()&&!['node_modules','data','managed-backups'].includes(entry.name)?files(path.join(directory,entry.name)):entry.isFile()?[path.join(directory,entry.name)]:[])}
async function main(){
 for(const filename of files(root).concat(files(path.join(root,'../miniprogram'))).filter(file=>/\.(?:js|cjs)$/.test(file))){const check=await run(path.relative(root,filename),['--check',filename]);if(!check.passed)report.checks.push(check)}
 report.checks.push({label:'JavaScript syntax',passed:report.checks.length===0})
 try{for(const filename of files(path.join(root,'../miniprogram')).filter(file=>file.endsWith('.json')))JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));report.checks.push({label:'Mini-program JSON',passed:true})}catch(error){report.checks.push({label:'Mini-program JSON',passed:false,output:error.message})}
 const tests=fs.readdirSync(path.join(root,'tests')).filter(file=>file.endsWith('.cjs')).sort()
 for(let index=0;index<tests.length;index+=2){const checks=await Promise.all(tests.slice(index,index+2).map(file=>run(file,[path.join(root,'tests',file)])));for(const check of checks){if(check.passed&&!check.output.includes('PASS:'))check.passed=false;report.checks.push(check);process.stdout.write(`${check.passed?'PASS':'FAIL'} ${check.label}\n`);if(!check.passed)process.stdout.write(check.output+'\n')}}
 const compilerRoot=process.env.APEX_WECHAT_COMPILER_DIR||'D:/app/wechatdev/微信web开发者工具/code/package.nw/node_modules/wcc-exec'
 for(const [name,args] of [['wcc.exe',['-d','-o',path.join(root,'data/wechat-compile/wxml.js'),'pages/index/index.wxml']],['wcsc.exe',['-js','-o',path.join(root,'data/wechat-compile/wxss.js'),'pages/index/index.wxss']]]){
  const filename=path.join(compilerRoot,name);if(fs.existsSync(filename))report.checks.push(await run(name,args,path.join(root,'../miniprogram'),filename));else report.checks.push({label:name,passed:false,output:'Official compiler not found; set APEX_WECHAT_COMPILER_DIR'})
 }
 fs.mkdirSync(path.join(root,'data'),{recursive:true});fs.writeFileSync(path.join(root,'data/selftest-report.json'),JSON.stringify(report,null,2)+'\n');const failed=report.checks.filter(check=>!check.passed);process.stdout.write(`${report.checks.length-failed.length}/${report.checks.length} checks passed\n`);if(failed.length)process.exitCode=1
}
main().catch(error=>{console.error(error);process.exitCode=1})
