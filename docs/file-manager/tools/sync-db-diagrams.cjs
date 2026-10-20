// Generate the standalone aggregate from the six authoritative detail diagrams.
// Usage: node sync-db-diagrams.cjs [--check]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../database');
const sections = [
  ['namespace', 'Дерево, доступ и история', '#E7F5FF'],
  ['content', 'Версии, загрузки и артефакты', '#EBFBEE'],
  ['bulk', 'Массовые задания и discovery', '#FFF9DB'],
  ['retention', 'Удержания и очистка', '#F3F0FF'],
  ['search-audit', 'Поиск, аудит и идемпотентность', '#E7F5FF'],
  ['administration', 'Роли и файловые права', '#FFF9DB']
];
const normalize = text => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
const definitions = new Set();
const edges = new Map();
function edge(from, arrow, to, label) {
  // The aggregate renders one edge per pair and arrow; multiple FK roles share a label.
  const key = [from, arrow, to].join(' ');
  const entry = edges.get(key) || { from, arrow, to, labels: new Set() };
  if (label) entry.labels.add(label);
  edges.set(key, entry);
}
let count = 0;
const packages = sections.map(([name, title, color]) => {
  const source = normalize(fs.readFileSync(path.join(directory, `sprut-file-manager-db-${name}.puml`), 'utf8'));
  const entities = [...source.matchAll(/^([ \t]*)entity "(\w+)" as \2[^\n{]*\{([\s\S]*?)^\1\}/gm)];
  assert(entities.length, `No tables in ${name}`);
  const blocks = entities.map(match => {
    assert(!definitions.has(match[2]), `Duplicate table: ${match[2]}`);
    definitions.add(match[2]); count++;
    const indent = match[1].length;
    return match[0].split('\n').map(line => `    ${line.slice(indent)}`).join('\n');
  });
  const comments = [...source.matchAll(/\/\'[\s\S]*?\'\//g)].map(match => match[0]);
  // Constraints remain source comments; they do not inflate the aggregate layout.
  blocks.push(...comments.map(comment => comment.split('\n').map(line => `    ${line.trimStart()}`).join('\n')));
  const withoutComments = source.replace(/\/\'[\s\S]*?\'\//g, '');
  for (const line of withoutComments.split('\n')) {
    const match = line.match(/^(\w+)\s+([|o{}<>.\-]+)\s+(\w+)(?:\s*:\s*(.*))?$/);
    if (match) edge(match[1], match[2], match[3], match[4]);
  }
  return `  ' Источник: sprut-file-manager-db-${name}.puml\n  package "${title}" as pkg_${name.replace(/-/g, '_')} ${color} {\n${blocks.join('\n\n')}\n  }`;
});
// Cross-section FKs not all shown in the compact detail diagrams.
[
  ['storage_space', '||--o{', 'content_object', 'space_id'],
  ['storage_space', '||--o{', 'upload_session', 'space_id'],
  ['fs_node', '|o--o{', 'upload_session', 'target_parent_id / file_node_id'],
  ['storage_space', '||--o{', 'export_artifact', 'space_id'],
  ['storage_space', '||--o{', 'corrector_rule_set', 'space_id'],
  ['storage_space', '||--o{', 'bulk_change_job', 'destination space'],
  ['storage_space', '|o--o{', 'bulk_change_item', 'COPY source_space_id'],
  ['file_version', '|o--o{', 'bulk_change_item', 'base / target / source / staged / result'],
  ['bulk_change_job', '||--o{', 'tree_history_hold', 'job_id'],
  ['storage_space', '||--o{', 'gc_task', 'space_id'],
  ['storage_space', '||--o{', 'search_index_task', 'space_id']
].forEach(args => edge(...args));
for (const { from, to } of edges.values()) {
  assert(definitions.has(from) || ['s3', 'opensearch'].includes(from), `Unknown edge: ${from}`);
  assert(definitions.has(to) || ['s3', 'opensearch'].includes(to), `Unknown edge: ${to}`);
}
const header = `' Полная схема sprut-file-manager: все ${count} таблиц на одном полотне.
' Генерируется tools/sync-db-diagrams.cjs из шести самостоятельных детальных схем.
' Править таблицы и ограничения следует в детальных схемах; --check проверяет отсутствие drift.
' Ограничения CHECK/FK/UNIQUE и индексы указаны в комментариях.
@startuml sprut-file-manager-db-all
title sprut-file-manager — полная PostgreSQL модель
hide methods
skinparam defaultFontName Arial
skinparam shadowing false
skinparam packageStyle rectangle
' Просторная компоновка без scale/fit-to-width.
skinparam nodesep 150
skinparam ranksep 180
skinparam padding 2
skinparam ArrowFontSize 12
legend left
  |= Обозначение |= Значение |
  | <<PK>> | колонка первичного ключа; несколько PK = один составной ключ |
  | <<FK>> | внешний ключ |
  | * | обязательная колонка |
  | Допустимые значения | константы, а не дополнительные колонки |
  | revision / lease_token | CAS и защита от устаревшего worker |
endlegend
package "PostgreSQL — sprut-file-manager" as pkg_db #F8F9FA {
`;
const output = normalize(`${header}${packages.join('\n\n')}\n}\n
entity "S3 / MinIO\\nimmutable objects" as s3 #EBFBEE
entity "OpenSearch\\nтекущие документы" as opensearch #FFF9DB

' bulk_change_item.source_node_id/target_parent_id и operation_id/holder_id — логические IDs.
${[...edges.values()].map(e => `${e.from} ${e.arrow} ${e.to}${e.labels.size ? ` : ${[...e.labels].join(' / ')}` : ''}`).join('\n')}
@enduml
`);
const target = path.join(directory, 'sprut-file-manager-db-all.puml');
if (process.argv.includes('--check')) {
  assert.equal(normalize(fs.readFileSync(target, 'utf8')), output, 'Aggregate drift: run sync-db-diagrams.cjs');
} else {
  fs.writeFileSync(target, output, 'utf8');
}
console.log(JSON.stringify({ valid: true, tables: count, aggregate: target, mode: process.argv.includes('--check') ? 'check' : 'generate' }));
