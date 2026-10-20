// Local structural checks for design artifacts; not an implementation security test.
// Usage: node validate-file-manager-design.cjs VALIDATOR_DIRECTORY
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const validatorDir = process.argv[2] && path.resolve(process.argv[2]);
assert(validatorDir, 'Pass the local directory containing yaml/package and tv4/package.');
const YAML = require(path.join(validatorDir, 'yaml/package'));
const tv4 = require(path.join(validatorDir, 'tv4/package'));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const spec = YAML.parse(read('contracts/sprut-file-manager-openapi.yaml'), { uniqueKeys: true });

function entities(text) {
  return [...text.matchAll(/^([ \t]*)entity "(\w+)" as \2[^\n{]*\{([\s\S]*?)^\1\}/gm)]
    .map(m => ({ name: m[2], body: m[3].split('\n').map(l => l.trim()).filter(Boolean).join('\n') }));
}
const aggregate = entities(read('database/sprut-file-manager-db-all.puml'));
const details = ['namespace', 'content', 'bulk', 'retention', 'search-audit', 'administration']
  .flatMap(name => entities(read(`database/sprut-file-manager-db-${name}.puml`)));
assert.equal(aggregate.length, 27);
assert.equal(details.length, 27);
assert.equal(new Set(details.map(e => e.name)).size, details.length, 'Duplicate detail table.');
let columns = 0;
for (const table of details) {
  assert.equal(aggregate.find(e => e.name === table.name)?.body, table.body, `Aggregate drift: ${table.name}`);
  for (const line of table.body.split('\n').filter(l => /^\*?\s*\w+\s*:\s*[A-Z]/.test(l))) {
    columns++;
    assert(/\[[^\]]+\]$/.test(line), `Missing visible column comment: ${table.name}: ${line}`);
  }
}
const table = name => { const t = details.find(t => t.name === name); assert(t, `Missing table ${name}`); return t.body; };
assert.match(table('fs_node'), /^tree_path : LTREE \[/m);
assert.match(table('fs_node'), /tree_path \[FOLDER\]/);
assert.match(table('fs_node'), /tree_path \[FILE\] = NULL/);
assert(!/tree_path\s*:/.test(table('node_revision')), 'Historical paths must be reconstructed from historical parent links.');
const namespace = read('database/sprut-file-manager-db-namespace.puml');
assert.match(namespace, /CREATE EXTENSION IF NOT EXISTS ltree/);
assert.match(namespace, /node_type='FILE' AND tree_path IS NULL/);
assert.match(namespace, /GiST\(tree_path\)/);
assert.match(namespace, /Deferred constraint trigger/);
assert.match(namespace, /maxAtomicMoveFolders/);
assert.match(read('architecture/sprut-file-manager-tree.md'), /Историческое дерево|История содержит исторические parent_node_id/);
for (const name of ['Node', 'CreateNode', 'MoveNode', 'RenameNode', 'RestoreTrash', 'NewUpload']) {
  assert(!spec.components.schemas[name].properties.treePath && !spec.components.schemas[name].properties.tree_path,
    `Internal path exposed by ${name}`);
}
assert(spec.components.schemas.Capabilities.required.includes('maxAtomicMoveFolders'));
assert.equal(spec.components.schemas.Capabilities.properties.maxAtomicMoveFolders.minimum, 1);
assert.match(table('node_acl'), /USER \| GROUP \| SERVICE \| ROLE/);
assert.match(table('node_acl'), /role_id : UUID <<FK>>/);
assert.match(table('access_role'), /\* space_id : UUID <<FK>>/);
assert(!details.some(t => t.name === 'integration_connection'));
assert(!/storage_profile_key|search_profile_key/.test(table('storage_space')));
assert.match(table('storage_space'), /storage_binding_fingerprint : CHAR\(64\)/);
assert(!spec.components.schemas.CreateConnection);
assert(!Object.keys(spec.paths).some(p => /^\/api\/v1\/connections/.test(p)));
assert(!spec.paths['/api/v1/infrastructure/profiles']);
for (const name of ['ProfileKey','InfrastructureProfile','InfrastructureProfiles']) assert(!spec.components.schemas[name]);
const infrastructure=YAML.parse(read('architecture/application-file-manager.example.yaml')).sprut['file-manager'];
assert(infrastructure.s3?.endpoint && infrastructure.s3.bucket && infrastructure.s3.credentials);
assert(infrastructure.opensearch?.endpoints?.length && infrastructure.opensearch['index-alias']);
assert(!infrastructure['storage-profiles'] && !infrastructure['search-profiles']);
assert(Number.isSafeInteger(infrastructure.limits['max-atomic-move-folders']) && infrastructure.limits['max-atomic-move-folders'] > 0);
for (const name of ['Space','CreateSpace','StorageStatus']) {
  assert(!spec.components.schemas[name].properties.storageProfileKey);
  assert(!spec.components.schemas[name].properties.searchProfileKey);
}
assert(spec.components.schemas.SetupStatus.required.includes('s3Configured'));
assert(spec.components.schemas.SetupStatus.required.includes('openSearchConfigured'));
assert(!spec.components.schemas.PlatformPermission.enum.includes('MANAGE_CONNECTIONS'));
assert.match(table('audit_event'), /^space_id : UUID/m, 'Administrative audit must support no space.');
assert.match(table('audit_event'), /\* tenant_id : UUID/);
assert.match(table('bulk_change_job'), /\* correlation_id : VARCHAR\(128\)/);
assert.match(table('storage_space'), /\* authorization_revision : BIGINT/);
assert.match(table('corrector_rule_set'), /\* revision : BIGINT/);
assert.match(table('file_version'), /VERSION_RESTORE/);
assert.match(table('bulk_change_job'), /COPY \| DELETE \| EXPORT \| VERSION_RETIREMENT/);
for (const column of ['cancel_mode', 'rollback_job_id', 'retry_of_job_id']) {
  assert.match(table('bulk_change_job'), new RegExp(`^${column} :`, 'm'));
}
for (const column of ['source_node_id', 'source_space_id', 'source_version_id', 'target_parent_id', 'target_name', 'archive_entry_path', 'before_state', 'result_content_revision', 'retry_of_item_id']) {
  assert.match(table('bulk_change_item'), new RegExp(`^${column} :`, 'm'));
}
assert.match(table('upload_session'), /current_attempt_id : UUID <<FK>>/);
assert.match(table('upload_session'), /\* content_type : VARCHAR\(255\)/);
assert(!/^\*?\s*(content_object_id|provider_upload_id) :/m.test(table('upload_session')), 'Attempt-owned fields must not be duplicated in session.');
assert.match(table('upload_attempt'), /\* upload_session_id : UUID <<FK>>/);
assert.match(table('upload_attempt'), /\* content_object_id : UUID <<FK>>/);
assert.match(table('upload_attempt'), /\* lease_token : BIGINT/);
assert.match(table('export_artifact'), /read_protected_until : TIMESTAMPTZ/);
assert.match(table('export_artifact'), /\* job_id : UUID <<FK>>/);
assert.match(table('version_hold'), /SHARE \| EXPORT/);
assert.match(read('database/sprut-file-manager-db-content.puml'), /Composite FK \(id,current_attempt_id\)/);
assert.match(read('database/sprut-file-manager-db-retention.puml'), /read_protected_until/);
assert.match(read('database/sprut-file-manager-db-bulk.puml'), /operation <> 'RETIRE_VERSION'/);
assert(!details.some(t => /^(user|users|user_role|role_membership)$/.test(t.name)), 'External memberships must not be duplicated.');

assert(!spec.components.securitySchemes.bearerAuth);
assert.deepEqual(Object.keys(spec.security[0]).sort(), ['TrustedActorId', 'TrustedActorType']);
assert(spec['x-transport-security'].callerAllowlist);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const identityRefs = ['ActorId', 'ActorType', 'ActorRoles', 'ActorGroups', 'Correlation'];
let operations = 0;
for (const [route, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    operations++;
    const params = [...(item.parameters || []), ...(operation.parameters || [])];
    for (const n of identityRefs) assert(params.some(p => p.$ref === `#/components/parameters/${n}`), `Missing ${n}: ${method} ${route}`);
    for (const response of Object.values(operation.responses)) {
      const value = response.$ref ? spec.components.responses[response.$ref.split('/').at(-1)] : response;
      assert(value.headers?.['X-Correlation-Id'], `Missing response correlation: ${method} ${route}`);
    }
  }
}
assert(!('storageProfileId' in spec.components.schemas.CreateSpace.properties));
assert(spec.components.schemas.CreateSpace.required.includes('initialAccess'));
assert.equal(spec.paths['/api/v1/spaces'].post['x-permission'], 'CREATE_SPACE');
assert(spec.paths['/api/v1/setup'].get && !spec.paths['/api/v1/setup'].post);
assert(!spec.paths['/api/v1/permissions'].post);
assert(!Object.keys(spec.paths).some(p => /user.*roles|role.*members/.test(p)), 'Membership API is external.');
assert.equal(spec.paths['/api/v1/retention-policies'].post['x-db-status'], 'covered');
assert(spec.components.schemas.AuditEvent.properties.spaceId.nullable);
assert(spec.components.schemas.Problem.required.includes('correlationId'));
const codes = table('role_permission').match(/permission_code = ([^\n]+)/)[1].split(' | ');
assert.deepEqual(codes, spec.components.schemas.FilePermission.enum);

function convert(value) {
  if (Array.isArray(value)) return value.map(convert);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (['nullable', 'example', 'discriminator', 'readOnly', 'writeOnly'].includes(key)) continue;
    result[key] = key === '$ref' ? child.replace('#/components/schemas/', '#/definitions/') : convert(child);
  }
  return value.nullable ? { anyOf: [result, { type: 'null' }] } : result;
}
const definitions = Object.fromEntries(Object.entries(spec.components.schemas).map(([n, v]) => [n, convert(v)]));
let schemaChecks = 0;
function check(name, data, expected) {
  const result = tv4.validateMultiple(data, { definitions, allOf: [{ $ref: `#/definitions/${name}` }] });
  assert.equal(result.missing.length, 0);
  assert.equal(result.valid, expected, `${name}: ${JSON.stringify(result.errors.map(({ message, dataPath }) => ({ message, dataPath })))}`);
  schemaChecks++;
}
const roleId = '423e4567-e89b-12d3-a456-426614174000';
const folder = {parentId:roleId,type:'FOLDER',name:'tests'};
check('CreateNode', folder, true);
check('CreateNode', {...folder,treePath:'n_root.n_tests'}, false);
check('CreateNode', {...folder,tree_path:null}, false);
check('MoveNode', {targetParentId:roleId}, true);
check('MoveNode', {targetParentId:roleId,treePath:'n_root.n_target'}, false);
check('MoveNode', {targetParentId:roleId,tree_path:'n_root.n_target'}, false);
const binding = { subjectType: 'ROLE', subjectId: roleId, inheritanceMode: 'SUBTREE' };
check('CreateAcl', binding, true);
check('CreateAcl', { ...binding, permissions: ['READ'] }, false);
check('CreateAcl', { subjectType: 'ROLE', inheritanceMode: 'SUBTREE' }, false);
check('CreateAcl', { subjectType: 'USER', subjectId: roleId, permissions: ['READ'] }, true);
check('CreateAcl', { subjectType: 'SERVICE', subjectId: roleId, permissions: ['READ', 'WRITE'] }, true);
check('CreateAcl', { subjectType: 'GROUP', subjectId: roleId, permissions: ['READ'] }, true);
check('CreateRole', { name: 'Редактор', permissions: ['READ', 'WRITE'] }, true);
check('CreateRole', { name: 'Администратор', permissions: ['CREATE_SPACE'] }, false);
check('CreateRole', { name: 'Пустая роль', permissions: [] }, false);
check('CreateRole', { name: 'Неизвестное действие', permissions: ['ARBITRARY_ACTION'] }, false);
check('CreateRole', { name: 'Дубликат', permissions: ['READ', 'READ'] }, false);
check('UpdateRole', {}, false);
check('UpdateRole', { status: 'ACTIVE' }, false);
check('UpdateRole', { status: 'ARCHIVED' }, true);
const space = {name:'Тесты',retentionPolicyId:roleId,
  initialAccess:[{subjectType:'USER',subjectId:roleId,permissions:['READ','ADMIN'],inheritanceMode:'SUBTREE'}]};
check('CreateSpace', space, true);
check('CreateSpace', {...space,endpoint:'https://private'}, false);
check('CreateSpace', {...space,storageConnectionId:roleId}, false);
check('CreateSpace', {...space,storageProfileKey:'main-s3'}, false);
check('CreateSpace', {...space,searchProfileKey:'main-search'}, false);
check('CreateSpace', {...space,bucket:'other'}, false);
check('CreateSpace', {...space,indexAlias:'other'}, false);
check('CreateSpace', {...space,s3:{endpoint:'https://private'}}, false);
check('CreateSpace', {...space,opensearch:{endpoints:['https://private']}}, false);
const upload = {mode:'NEW',parentId:roleId,name:'callsequence',contentType:'text/plain'};
check('CreateUpload', upload, true);
check('CreateUpload', {...upload,expectedSizeBytes:null}, true);
check('CreateUpload', {...upload,expectedSizeBytes:0}, true);
check('CreateUpload', {...upload,expectedSizeBytes:-1}, false);
check('CreateUpload', {...upload,key:'unsafe/key'}, false);
check('NodeAncestors', {nodeId:roleId,spaceId:roleId,items:[]}, true);
check('NodeAncestors', {nodeId:roleId,spaceId:roleId,items:[{id:roleId}]}, false);
check('CorrelationId', 'integration:payment-123', true);
check('CorrelationId', '', false);
check('CorrelationId', 'a'.repeat(129), false);
check('CorrelationId', 'value\r\nInjected: header', false);
const problem = structuredClone(spec.components.schemas.Problem.example);
check('Problem', problem, true);
delete problem.correlationId; check('Problem', problem, false);

for (const file of ['requirements/sprut-file-manager-functional-requirements.md', 'requirements/sprut-file-manager-non-functional-requirements.md', 'contracts/sprut-file-manager-mvc-contract.md', 'contracts/sprut-file-manager-openapi-notes.md', 'architecture/sprut-file-manager-tree.md']) {
  const text = read(file);
  assert(!/rate.?limit|\b429\b/i.test(text), `Unexpected request-rate control: ${file}`);
  assert.equal([...text.matchAll(/^```/gm)].length % 2, 0, `Unpaired fence: ${file}`);
  const ids = [...text.matchAll(/^### ((?:FR|NFR)-\d{3})\./gm)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, `Duplicate requirement ID: ${file}`);
  for (let i = 0; i < ids.length; i++) assert.equal(ids[i], `${ids[0].split('-')[0]}-${String(i + 1).padStart(3, '0')}`);
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:\/\/|^#/.test(m[1])) continue;
    assert(fs.existsSync(path.resolve(root, path.dirname(file), m[1])), `Missing Markdown link: ${file}: ${m[1]}`);
  }
}
const operationIds = new Set(Object.values(spec.paths).flatMap(item => Object.entries(item)
  .filter(([method]) => methods.has(method)).map(([, operation]) => operation.operationId)));
for (const line of read('contracts/sprut-file-manager-mvc-contract.md').split('\n')) {
  if (!line.startsWith('| /') || line.split('|').length !== 6) continue;
  const operationId = line.split('|')[3].trim();
  assert(operationIds.has(operationId), `MVC refers to an unknown REST/application operation: ${operationId}`);
}
console.log(JSON.stringify({ valid: true, tables: aggregate.length, columns, operations, schemaChecks,
  verification: 'Static artifacts only; runtime authorization, concurrency, secret encryption and replica reload require implementation tests.' }, null, 2));
