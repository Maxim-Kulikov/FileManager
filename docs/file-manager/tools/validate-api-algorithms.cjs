// Static alignment of activity diagrams and OpenAPI; not a runtime test.
// Usage: node validate-api-algorithms.cjs VALIDATOR_DIRECTORY
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
assert(process.argv[2],'Pass the directory containing yaml/package.');
const Y=require(path.resolve(process.argv[2],'yaml/package'));
const spec=Y.parse(fs.readFileSync(path.join(root,'contracts/sprut-file-manager-openapi.yaml'),'utf8'));
const operations=new Map();for(const[p,item]of Object.entries(spec.paths))for(const[m,o]of Object.entries(item))if(o.operationId)operations.set(o.operationId,{method:m.toUpperCase(),path:p});
const errorCodes=new Set(spec.components.schemas.Problem.properties.code.enum);
function dereference(value){
  if(!value?.$ref)return value;
  return value.$ref.slice(2).split('/').reduce((object,key)=>object[key],spec);
}
function schemaFields(schema,seen=new Set()){
  const value=dereference(schema);
  if(!value||seen.has(value))return [];
  seen=new Set(seen);seen.add(value);
  return [...Object.keys(value.properties||{}),
    ...Object.values(value.properties||{}).flatMap(field=>schemaFields(field,seen)),
    ...(value.items?schemaFields(value.items,seen):[]),
    ...['oneOf','allOf','anyOf'].flatMap(key=>(value[key]||[]).flatMap(item=>schemaFields(item,seen)))];
}
let count=0;
const guide=fs.readFileSync(path.join(root,'api/README.md'),'utf8');
for(const section of ['REQ','TREE','ACL','IDEMP','HIST','INDEX','UPLOAD_ACCESS','REPLAY_UPLOAD','FAIL_TRANSFER','CLEANUP','ERR']){
  assert(guide.includes(section),'Missing shared algorithm: '+section);
}
for(const file of fs.readdirSync(path.join(root,'api')).filter(f=>f.endsWith('.puml'))){
  const text=fs.readFileSync(path.join(root,'api',file),'utf8');
  assert.equal((text.match(/^@startuml/gm)||[]).length,1,file);
  assert.equal((text.match(/^@enduml/gm)||[]).length,1,file);
  assert(!/!include(?:url)?|rate.?limit|\b429\b/i.test(text),file);
  assert(!/Ответ\s+\d{3}\s*(?:\/\s*\d{3}|,\s*\d{3}|либо\s+\d{3})/i.test(text),'Ambiguous HTTP response: '+file);
  assert(!/Session недоступна, отменена или истекла|проверить UPLOAD_FENCE/i.test(text),'Unspecified state check: '+file);
  const id=text.match(/^' operationId: (\w+)$/m)?.[1];
  if(!id){assert(file.startsWith('WORKFLOW.'),'Missing operation metadata: '+file);continue;}
  const op=operations.get(id);assert(op,'Unknown operationId: '+id);
  assert.equal(text.match(/^' method: (\w+)$/m)?.[1],op.method,file);
  assert.equal(text.match(/^' path: (.+)$/m)?.[1].trim(),op.path,file);
  const expected=op.method+'.sprut-file-manager'+op.path.replaceAll('/','.')+'_AD.puml';
  assert.equal(file,expected,'Endpoint/filename mismatch');count++;
  if (['listChildren','getNodeAncestors'].includes(id)) {
    assert(text.includes('tree_path'),'Missing ltree read: '+file);
    assert(!/Recursive CTE/i.test(text),'Current tree must not use full recursive CTE: '+file);
  }
  if (id==='createSpace') assert(text.includes('tree_path = label(rootId)'));
  if (id==='createNode') assert(text.includes('tree_path = parent.tree_path || label(nodeId)'));
  if (id==='completeUploadSession') assert(text.includes('tree_path = NULL'));
  if (id==='moveNode') {
    for (const value of ['maxAtomicMoveFolders','TRASHED/PURGING','oldPrefix','newPrefix','413 RESOURCE_LIMIT_EXCEEDED'])
      assert(text.includes(value),'Incomplete atomic path rewrite: '+value);
    assert(text.includes('Между пакетами UPDATE папок нет COMMIT'));
  }
  const request=text.match(/\n:Request;\nnote right\n([\s\S]*?)\nend note/)?.[1];
  const response=text.match(/\nnote right\nResponse\n([\s\S]*?)\nend note/)?.[1];
  assert(request&&response,'Missing Request/Response field blocks: '+file);
  const operation=spec.paths[op.path][op.method.toLowerCase()];
  for(const parameter of (operation.parameters||[]).map(dereference)){
    assert(request.includes(parameter.name+(parameter.required?'*':'?')),'Missing request parameter: '+parameter.name+' in '+file);
  }
  for(const content of Object.values(dereference(operation.requestBody)?.content||{})){
    for(const field of schemaFields(content.schema))assert(request.includes(field),'Missing request body field: '+field+' in '+file);
  }
  for(const [status,item]of Object.entries(operation.responses).filter(([status])=>Number(status)<400)){
    assert(response.includes(status+':'),'Missing response status: '+status+' in '+file);
    const resolved=dereference(item);
    for(const header of Object.keys(resolved.headers||{}))assert(response.includes(header),'Missing response header: '+header+' in '+file);
    for(const content of Object.values(resolved.content||{})){
      for(const field of schemaFields(content.schema))assert(response.includes(field),'Missing response body field: '+field+' in '+file);
    }
  }
  if(op.method!=='HEAD')for(const field of schemaFields(spec.components.schemas.Problem))assert(response.includes(field),'Missing Problem field: '+field+' in '+file);
  const expectedFrames={uploadContent:2,completeUploadSession:3}[id]||1;
  assert.equal((text.match(/^partition "TX[^\n]+\{$/gm)||[]).length,expectedFrames,'Transaction frame count: '+file);
  for(const match of text.matchAll(/Ответ\s+(4\d{2}|5\d{2})\s+([A-Z_]+)/g)){
    assert(errorCodes.has(match[2]),'Unknown Problem.code: '+match[2]+' in '+file);
  }
}
assert.equal(count,14,'Missing current endpoint algorithms');
for(const name of ['uploadContent','completeUploadSession','abortUploadSession','getUploadSession']){
  const file=fs.readdirSync(path.join(root,'api')).find(f=>f.endsWith('.puml')&&fs.readFileSync(path.join(root,'api',f),'utf8').includes("' operationId: "+name+'\n'));
  assert(file,'Missing upload algorithm: '+name);
  const text=fs.readFileSync(path.join(root,'api',file),'utf8');
  assert(/upload_session/.test(text)&&/id\s*=\s*uploadId/.test(text),'Missing session lookup: '+file);
  assert(/created_by/.test(text),'Missing session owner check: '+file);
}
assert(!Object.keys(spec.paths).some(p=>p.includes('directory-upload')),'Directory workflow must not invent a server endpoint.');
const upload=spec.paths['/api/v1/uploads/{uploadId}/content'].put;
assert.equal(upload.parameters.find(p=>p.name==='Content-Length').required,false);
assert(!spec.components.schemas.NewUpload.required.includes('expectedSizeBytes'));
assert(spec.components.schemas.Upload.required.includes('transferStatus'));
assert(spec.paths['/api/v1/nodes/{nodeId}/ancestors'].get);
console.log(JSON.stringify({valid:true,endpointAlgorithms:count,directoryWorkflow:true,checks:'Static contract mapping; PlantUML syntax and runtime semantics checked separately.'},null,2));
