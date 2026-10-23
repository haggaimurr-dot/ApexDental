const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
function createDocumentSigner(dataDir){
 const filename=path.join(dataDir,'document-signing-key.pem')
 let privateKey
 if(fs.existsSync(filename))privateKey=crypto.createPrivateKey(fs.readFileSync(filename))
 else{const pair=crypto.generateKeyPairSync('ed25519');const pem=pair.privateKey.export({type:'pkcs8',format:'pem'});fs.writeFileSync(filename,pem,{flag:'wx',mode:0o600});privateKey=pair.privateKey}
 const publicKey=crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'})
 return {sign:payload=>({signature:crypto.sign(null,Buffer.from(payload),privateKey).toString('base64'),publicKey}),verify:(payload,signature,key)=>{try{return crypto.verify(null,Buffer.from(payload),crypto.createPublicKey(key),Buffer.from(signature,'base64'))}catch{return false}}}
}
module.exports={createDocumentSigner}
