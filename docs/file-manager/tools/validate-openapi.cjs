// Local validation only: project data never leaves this process.
// Usage: node validate-openapi.cjs SPEC.yaml VALIDATOR_DIRECTORY
// Directory contains yaml/package, tv4/package, openapi-3.0-schema.json.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const specPath = path.resolve(process.argv[2] || path.join(__dirname, '../contracts/sprut-file-manager-openapi.yaml'));
const validatorDir = process.argv[3] && path.resolve(process.argv[3]);
assert(validatorDir, 'Pass the local validator directory as the second argument.');
const YAML = require(path.join(validatorDir, 'yaml/package'));
const tv4 = require(path.join(validatorDir, 'tv4/package'));
const metaSchema = JSON.parse(fs.readFileSync(path.join(validatorDir, 'openapi-3.0-schema.json'), 'utf8'));
tv4.addSchema(metaSchema.id, metaSchema);
const parsed = YAML.parseDocument(fs.readFileSync(specPath, 'utf8'), { uniqueKeys: true });
assert.equal(parsed.errors.length, 0, parsed.errors.map(e => e.message).join('\n'));
const spec = parsed.toJS();
const schemaResult = tv4.validateMultiple(spec, metaSchema);
assert(schemaResult.valid, JSON.stringify(schemaResult.errors.map(({ message, dataPath, subErrors }) => ({
  message, dataPath, subErrors: subErrors?.map(({ message, dataPath }) => ({ message, dataPath }))
})), null, 2));
assert.equal(schemaResult.missing.length, 0, 'Official schema has unresolved references.');
// Negative controls: validation must actually reject malformed documents.
const noInfo = structuredClone(spec);
delete noInfo.info;
assert.equal(tv4.validateMultiple(noInfo, metaSchema).valid, false, 'Validator accepted missing info.');
const wrongVersion = structuredClone(spec);
wrongVersion.openapi = 'not-openapi';
assert.equal(tv4.validateMultiple(wrongVersion, metaSchema).valid, false, 'Validator accepted an invalid OpenAPI version.');
assert.equal(spec.servers[0].url, '/sprut-file-manager');

function resolve(ref) {
  assert(ref.startsWith('#/'), `External reference is not allowed: ${ref}`);
  let current = spec;
  for (const segment of ref.slice(2).split('/')) {
    current = current?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  assert(current !== undefined, `Unresolved reference: ${ref}`);
  return current;
}

function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) resolve(value.$ref);
  if (value.required && value.properties) {
    for (const field of value.required) assert(field in value.properties, `Unknown required field: ${field}`);
  }
  for (const child of Object.values(value)) walk(child);
}
walk(spec);

const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);
const operationIds = new Set();
let extensionCount = 0;
for (const [route, item] of Object.entries(spec.paths)) {
  assert(route.startsWith('/api/v1/'), `Wrong API prefix: ${route}`);
  assert(!route.includes('/sprut-file-manager'), 'Context path duplicated in paths.');
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    assert(!operationIds.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
    operationIds.add(operation.operationId);
    assert(operation.responses && Object.keys(operation.responses).length, `Missing responses: ${route}`);
    assert(operation['x-permission'], `Missing permission: ${operation.operationId}`);
    if (operation['x-db-status'] === 'extension-required') {
      extensionCount++;
      assert(operation['x-db-extension'], 'Missing database extension explanation.');
    }
    const parameters = [...(item.parameters || []), ...(operation.parameters || [])].map(p => p.$ref ? resolve(p.$ref) : p);
    const identities = parameters.map(p => `${p.in}:${p.name}`);
    assert.equal(new Set(identities).size, identities.length, `Duplicate parameter: ${route}`);
    const placeholders = [...route.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
    const pathParameters = parameters.filter(p => p.in === 'path');
    assert.deepEqual(pathParameters.map(p => p.name).sort(), placeholders, `Path parameter mismatch: ${route}`);
    for (const p of pathParameters) assert.equal(p.required, true);
    assert((operation.security || spec.security).length > 0, `Unsecured operation: ${route}`);
  }
}

// Convert the Schema Object subset into draft-04 for example validation.
// nullable is an OpenAPI keyword, not a JSON Schema draft-04 keyword.
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
const definitions = Object.fromEntries(Object.entries(spec.components.schemas).map(([name, schema]) => [name, convert(schema)]));
let examples = 0;
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  if (schema.example === undefined) continue;
  const result = tv4.validateMultiple(schema.example, { definitions, allOf: [{ $ref: `#/definitions/${name}` }] });
  assert(result.valid, `Invalid example ${name}: ${JSON.stringify(result.errors, null, 2)}`);
  assert.equal(result.missing.length, 0);
  examples++;
}
const stream = spec.paths['/api/v1/nodes/{nodeId}/children/stream'].get.responses['200'].content['application/x-ndjson'].example;
for (const line of stream.trim().split('\n')) {
  const result = tv4.validateMultiple(JSON.parse(line), { definitions, allOf: [{ $ref: '#/definitions/StreamRecord' }] });
  assert(result.valid, `Invalid NDJSON example: ${JSON.stringify(result.errors)}`);
  assert.equal(result.missing.length, 0);
  examples++;
}
console.log(JSON.stringify({ valid: true, standard: spec.openapi, paths: Object.keys(spec.paths).length, operations: operationIds.size,
  schemas: Object.keys(spec.components.schemas).length, examplesValidated: examples, extensionRequiredOperations: extensionCount }, null, 2));
