const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite')
function restoreCopy(source,target,expectedDigest){
 const input=path.resolve(source),output=path.resolve(target),parent=path.dirname(output)
 if(input===output||path.extname(output)!=='.sqlite'||!fs.existsSync(parent)||!fs.statSync(parent).isDirectory()||fs.existsSync(output))throw Error('Use a new .sqlite file in an existing destination directory; active databases are never overwritten')
 if(fs.lstatSync(input).isSymbolicLink()||!fs.statSync(input).isFile())throw Error('The source must be an ordinary backup file')
 const bytes=fs.readFileSync(input),digest=crypto.createHash('sha256').update(bytes).digest('hex')
 if(expectedDigest&&digest!==expectedDigest)throw Error('Backup SHA-256 does not match')
 const sourceDb=new DatabaseSync(input,{readOnly:true});try{if(sourceDb.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity check failed')}finally{sourceDb.close()}
 fs.copyFileSync(input,output,fs.constants.COPYFILE_EXCL)
 const restored=new DatabaseSync(output,{readOnly:true});try{if(restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Restored copy failed integrity check')}finally{restored.close()}
 return {path:output,digest,verified:true,note:'Verified restore copy created. Stop the service and select this database explicitly before using it.'}
}
if(require.main===module){try{const [source,target,digest]=process.argv.slice(2);if(!source||!target)throw Error('Usage: node restore-backup.cjs source.sqlite new-destination.sqlite [sha256]');console.log(JSON.stringify(restoreCopy(source,target,digest),null,2))}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={restoreCopy}
