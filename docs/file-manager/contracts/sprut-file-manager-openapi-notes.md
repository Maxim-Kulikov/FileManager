# Sprut File Manager: контракт и перенос существующей логики

Основной файл: [sprut-file-manager-openapi.yaml](sprut-file-manager-openapi.yaml). Спецификация самостоятельная: все схемы и `$ref` находятся внутри файла. Формат: OpenAPI 3.0.3.

## Просмотр спецификации

Просмотр выполняется через локальный OpenAPI/Swagger preview IDE либо импорт YAML в Swagger Editor. Импорт на внешний сайт передаёт туда архитектуру проекта: для внутренних данных предпочтителен локальный просмотр. `servers[0].url = /sprut-file-manager`; пути начинаются с `/api/v1`, например `/sprut-file-manager/api/v1/jobs/{jobId}`. Повторное добавление context path к путям запрещено.

Tags группируют endpoint'ы. `x-permission` задаёт требуемое право; общие tenant/ancestor/space проверки обязательны дополнительно. `x-legacy-operation` показывает старый контракт. `x-db-status: extension-required` и `x-db-extension` указывают необходимые расширения PUML. Поля `x-*` могут не отображаться конкретным viewer: важные ограничения также продублированы в описаниях и ниже.

## Дерево parent_id + ltree

fs_node.tree_path — внутренний LTREE только для папок; FILE имеет NULL. REST path остаётся вычисляемым путём из имён. treePath/tree_path не принимаются в body и не возвращаются в Node. [Алгоритмы дерева](../architecture/sprut-file-manager-tree.md).

Current subtree и предки выбираются по техническим UUID-путям без Recursive CTE; файлы — через JOIN родителя. ACL и статусы предков проверяются отдельно. Direct order — FOLDER first/name/id, recursive — id. Размер страницы не является пределом работы SQL; большие выборки требуют фоновой подготовки manifest.

Создание, COPY и restore вычисляют пути от текущего parent. Move папки атомарно обновляет все folder prefixes, включая TRASHED/PURGING; rename не меняет их. maxAtomicMoveFolders из capabilities/YAML ограничивает atomic move; превышение — 413 RESOURCE_LIMIT_EXCEEDED без изменений. Частичная фоновая смена prefix не допускается. node_revision хранит исторические parent links, не tree_path.

## Единая YAML-конфигурация, spaces и роли

[MVC-контракт](sprut-file-manager-mvc-contract.md) описывает HTML/forms/CSRF/303; OpenAPI остаётся REST-контрактом. MVC и REST вызывают общий application layer.

Tenant берётся из YAML/env; Bearer пользовательского токена проверяет gateway. Внутренний API принимает X-Actor-Id/Type/Roles/Groups после mTLS/workload authentication и caller allowlist. apiKey security schemes в OpenAPI 3.0 обозначают заголовки pre-authenticated identity, не секреты и не замену caller authentication.

MinIO и OpenSearch имеют по одной общей конфигурации из YAML. API каталога подключений отсутствует. createSpace принимает name, retentionPolicyId и initialAccess. Общий bucket разделяется prefix пространства, общий index alias — tenantId/spaceId и ACL. PostgreSQL фиксирует размещение/fingerprints, не endpoints/credentials. Retention policy создаётся заранее защищённым REST; ноль spaces допустим.

Файловые роли access_role/role_permission ограничены space и действуют только через node_acl ROLE bindings. Каталог читается уполномоченной внешней системой, user-role membership остаётся снаружи. Прямые USER/GROUP/SERVICE grants сохранены. Фиксированные READ/WRITE/DELETE/SHARE/ADMIN не расширяются произвольным permission code через UI; ADMIN — файловый код, не platform administrator. Права service-level отделены. Источник актуальности memberships и worker refresh/expiry protocol остаются обязательным открытым интеграционным решением; старый role snapshot не разрешает commit.

X-Correlation-Id опционален во входе, генерируется при отсутствии и возвращается в HTTP-ответах/Problem. traceId/spanId и Idempotency-Key имеют отдельные назначения. Контекст job и административный аудит расширены без хранения токенов/секретов. Audit допускает spaceId=null для первичной настройки.

## Основания

Исследованы `S3Controller`, `ProxyS3Controller`, `ModelCorrectorController` в `D:/sprut/sprut-web-service/src/main/java/ru/vtb/rkk/domain/controller`, их request/response DTO, facade/config cache/processors трёх корректоров, `S3MinioService`, `OpenSearchServiceImpl`, JSON task/payload/edit/filter модели, `Infra.JsonUtil.replaceDates` и `Infra.TextUtils.stringWithReplacedId`.

Спецификация опирается на [функциональные требования](../requirements/sprut-file-manager-functional-requirements.md), [нефункциональные требования](../requirements/sprut-file-manager-non-functional-requirements.md) и [общую модель БД](../database/sprut-file-manager-db-all.puml). Контракт включает связанный workflow cancel/rollback и модель прогресса. Соответствие требованиям и PUML ограничено перечисленными ниже расширениями модели.

Формат и HTTP-семантика: [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). Проверка структуры использует [официальную JSON Schema OpenAPI 3.0.x](https://spec.openapis.org/oas/3.0/schema/2024-10-18).

## Покрытие исходных endpoint'ов

Пути указаны без `/sprut-file-manager/api/v1`.

| Источник | Старый endpoint | Контракт / изменение |
|---|---|---|
| S3Controller | POST /api/v2/s3/index/upsert | POST /spaces/{spaceId}/index/requests, action UPSERT; данные берёт сервис, не клиент |
| S3Controller | POST /api/v2/s3/index/delete | Там же TOMBSTONE, только для реально удалённого/trashed узла |
| S3Controller | POST /api/v2/s3/index/deleteByPrefix | Там же selection roots/subtree; произвольное удаление живой проекции запрещено |
| S3Controller | GET /api/v2/s3/search | POST /spaces/{spaceId}/search; q/mode/type/scope, cursor и ACL |
| S3Controller | GET /api/v2/s3/credentials | GET /spaces и /capabilities; старый DTO фактически возвращал bucket, постоянные credentials не выдаются |
| S3Controller | POST /api/v2/s3/rollback | POST /spaces/{spaceId}/jobs/tree-restore; timezone и безопасная история вместо уничтожения поздних версий |
| ProxyS3Controller | GET /api/s3/{bucket}/download-zip | POST /spaces/{spaceId}/jobs/export → GET /jobs/{jobId}/artifact/content |
| ProxyS3Controller | GET /api/s3/{bucket}/versioning | GET /spaces/{spaceId}/storage-status; logical и native versioning различаются |
| ProxyS3Controller | PUT /api/s3/{bucket}/object/** | POST /spaces/{spaceId}/uploads UPDATE → PUT /uploads/{uploadId}/content → POST complete |
| ProxyS3Controller | PUT /api/s3/{bucket}/file | Upload NEW; create FILE metadata отдельно используется для placeholder, затем UPDATE |
| ProxyS3Controller | PUT /api/s3/{bucket}/folder | POST /spaces/{spaceId}/nodes type FOLDER; без S3 directory marker |
| ProxyS3Controller | GET /api/s3/{bucket}/object?key= | Resolve node → GET /nodes/{nodeId}/content, optional versionId |
| ProxyS3Controller | GET /api/s3/{bucket}/object/** | Тот же content API; корректные single Range/206/416 и empty-file 200 |
| ProxyS3Controller | GET /api/s3/{bucket}/objects | GET /nodes/{nodeId}/children recursive=false; folders — обычные Node, не CommonPrefixes |
| ProxyS3Controller | GET /api/s3/{bucket}/objectsRecursive | GET children recursive=true либо children/stream NDJSON |
| ProxyS3Controller | DELETE /api/s3/{bucket}/object/** | DELETE /nodes/{nodeId}: корзина. При versionId — административный retire версии с проверкой защищённости |
| ProxyS3Controller | POST /api/s3/{bucket}/delete | POST /spaces/{spaceId}/jobs/delete с явным selection; не список raw keys/versions |
| ProxyS3Controller | POST /api/s3/{bucket}/copy | POST /spaces/{spaceId}/jobs/copy; source node/version, target parent/name, включая межпространственную копию при разрешениях |
| ProxyS3Controller | GET /api/s3/{bucket}/versions?key= | GET /nodes/{nodeId}/versions |
| ProxyS3Controller | GET /api/s3/{bucket}/versions?prefix= | GET /spaces/{spaceId}/versions?rootNodeId= |
| ProxyS3Controller | POST /api/s3/{bucket}/deleteByPrefix | POST jobs/delete selection; TRASH или ADMIN PURGE, retention/holds нельзя обойти |
| ProxyS3Controller | GET /api/s3/{bucket}/presign | POST /nodes/{nodeId}/download-links: version-specific URL/TTL/hold |
| ModelCorrectorController | POST /api/v1/model-corrector | POST /spaces/{spaceId}/corrector-rule-sets; typed rule вместо JSON в строке value |
| ModelCorrectorController | DELETE /api/v1/model-corrector/{id} | PATCH /corrector-rule-sets/{ruleSetId} status ARCHIVED, историю/запуски не уничтожает |
| ModelCorrectorController | PATCH /api/v1/model-corrector | PATCH имя/status и POST /corrector-rule-sets/{ruleSetId}/versions для новой definition |
| ModelCorrectorController | GET /api/v1/model-corrector/{id} | GET шаблон и конкретную immutable версию |
| ModelCorrectorController | GET /api/v1/model-corrector/all | GET /spaces/{spaceId}/corrector-rule-sets постранично |
| ModelCorrectorController | POST /api/v1/model-corrector/execute | POST /spaces/{spaceId}/jobs/corrector; ruleVersionId + ROOT/EXCLUDE IDs |
| ModelCorrectorController | GET /api/v1/model-corrector/executions | GET /spaces/{spaceId}/jobs?type=CORRECTOR |
| ModelCorrectorController | GET /api/v1/model-corrector/executions/{id} | GET /jobs/{jobId}, /items для исходов/ошибок |

Это функциональная совместимость, не byte-for-byte совместимость S3-like JSON. При необходимости старые пути обслуживает миграционный adapter, разрешающий старый bucket/prefix в space/node и вызывающий тот же authoritative workflow. Нельзя оставлять старому proxy параллельное право напрямую менять S3 bytes.

## Совместимость корректоров

- TXT_REGULAR: ALL/ANY file rules; S3_KEY/PREFIX/PREFIX_PART/FILENAME/FILENAME_PART/EXTENSION и STARTS_WITH/CONTAINS/ENDS_WITH/EQUALS/MATCHES_REGEX. S3_KEY теперь LOGICAL_PATH, PREFIX относится к parent path, `.json` при миграции extension нормализуется в `json`. Regex filter сохраняет find semantics. roots из шаблона только сужают область execute; excludes объединяются. Enabled, case sensitivity, TEXT/REGEX, first/all, empty replacement, порядок замен сохранены.
- В старом TEXT processor replacement всё равно проходил через Java Matcher: `$` и backslash могли интерпретироваться. Новый контракт различает literal TEXT replacement и группы REGEX. Миграционный adapter обязан проверить сохранённые шаблоны с `$`/backslash, с сохранением исходной семантики.
- TEST_JSON: сохраняются taskSequence, insert/edit/delete/replace, targetAddress, deleteAddress/globalDeleteAddress, applyToWholeJson, source request/response, call/stage filters, вложенные payLoad/payloadObject/editFields, direct/extracted values и equals/contains/contains_ editor matching. Старый язык адресов с дефисами явно назван LEGACY_HYPHEN, его синтаксис не соответствует JSON Pointer. taskSequence уникален; semantic combinations валидируются engine до запуска. Сохраняется legacy discovery testCase на два уровня выше папки request и layout call/request|response/stage.json|txt. Атомарность по файлу, не всей testCase.
- PARAMETRIZATION: DATE и CUSTOMER_REQUEST_EXT_ID — не произвольное генерирование новых дат/ID. DATE превращает распознанные даты в относительные `[today...]`/соответствующие date-time шаблоны, сохраняя business sentinel exceptions исходного Infra.JsonUtil. CUSTOMER_REQUEST_EXT_ID также заменяет loanRequestId на `[loanRequestId]`, customer/loan request external ID — на `[customerRequestExtId]`, как Infra.TextUtils. Reference date фиксируется в job snapshot, чтобы retry не менял relative offsets. Новые customExpressions отдельно выполняются sandbox engine.
- Неизменённые bytes дают UNCHANGED без лишней версии. Поэлементные ошибки теперь доступны явно; старое "finished counter" после failure не считается успешным результатом. Создание immutable snapshot заменяет зависимость job от mutable cache шаблона.
- Engine IDs в примерах условные; допустимые значения определяются установленными plugins. Неподдерживаемая версия/язык отвергается. Формат JSON values/payload нельзя ограничивать только объектами: поддерживаются JSON скаляры/массивы/null.

## Конкурентность, ограничения и workflow

1. Node metadata ETag и content CAS раздельны: смена markers не делает содержимое новым, а upload не перезаписывает параллельное сохранение. If-Match mismatch — 412; name/cycle/job state conflict — 409. ROOT нельзя удалить/переместить. Проверка parent-space/FOLDER/ancestry обязательна.
2. По умолчанию schema ограничивает page size/roots/rules до 1000, name до 255 символов, logical path до 4096, presign TTL до 3600 секунд, parallel items до 64. Это верхние границы входных параметров API, а не показатели производительности. /capabilities может дать меньшие effective limits; общий размер дерева ими не ограничивается. Body/transform/file/session/DSL budgets конфигурационные и проверяются независимо от JSON Schema.
3. Upload принимает известный либо неизвестный размер: expectedSizeBytes/Content-Length опциональны, фактический byte limit обязателен. Один writer/session; после failed attempt живая session получает новый attempt/key. После потери ответа GET возвращает transferStatus/attemptNumber, отличая активную передачу от UPLOADED receipt. Offset resume не поддерживается. NEW публикует узел только при finalize; FILE placeholder обновляется через UPDATE с baseVersionId=null.
4. Подписанные GET URLs сохраняют остаточное окно доступа до TTL; немедленный отзыв не гарантируется. SHARE hold/TTL защищает bytes от GC. При replay по Idempotency-Key исходный TTL не продлевается. URL/response replay хранятся защищённо, не попадают в audit/logs.
5. Jobs 202 после commit; partial result допустим. Progress до окончания discovery: total/percent=null; после окончания denominator фиксирован, progress учитывает уникальные терминальные исходы, а не attempts. Повторный I/O отдельно в telemetry. FINALIZING не означает complete даже при 100% processing. Poll из UI, summary переживает detail retention.
6. STOP_AND_ROLLBACK не возвращает всё дерево к времени начала. Durable intent создаёт уникальную связанную компенсацию после остановки; holds не освобождаются между фазами. Поздние чужие edits сохраняются как CONFLICT. PURGE/EXPORT не компенсируются. Ошибка rollback не означает, что исходные результаты исчезли.
7. Copy same-space может разделять immutable object; cross-space делает новую storage reference/transfer согласно границе. Новый nodeId для копии; markers переносятся, ACL источника не переносится. Копирование в собственное поддерево запрещено; visibility partial results соответствует per-item workflow. Отмена с компенсацией COPY должна учитывать новые чужие children, references и последующие mutations, не удалять целиком чужое дерево.
8. ZIP доступен только как полностью подготовленный artifact; manifest versions held, Zip Slip/duplicate entries/ZIP64 обработаны. ACL источников перепроверяется при скачивании. Глобальный point-in-time snapshot дерева не гарантируется.
9. PURGE/version retirement не обходят current pointer, holds, shared objects и retained node_revision. Cancel purge не восстанавливает уже физически удалённые bytes. Изменение retention не отбирает действующие holds.
10. Metadata queries для файлов и папок с файлом не зависят от eventual OpenSearch. Полные paths и markers выдаются из PostgreSQL. Text search актуализирует ACL/existence перед раскрытием snippets; HTML экранируется фронтом.

## Покрытие обновлённой моделью БД

Модель БД содержит 27 таблиц. Определения агрегата генерируются из шести детальных схем через `tools/sync-db-diagrams.cjs`.

| Возможность | Модель |
|---|---|
| COPY/DELETE/EXPORT | job_type и типизированные item operations, source/target fields, CAS, before_state и dependencies |
| Copy resultNodeId | node_id назначения выделяется при discovery и повторно используется; отдельная result-колонка не нужна |
| Export manifest/artifact | EXPORT_ENTRY items и export_artifact с TTL, read pin и EXPORT holds |
| Durable cancellation | cancel_mode и уникальная связь rollback_job_id; intent сохраняется до admission компенсации |
| Retry lineage | retry_of_job_id/retry_of_item_id отдельно от source_job_id/source_item_id компенсации |
| Rule-set metadata CAS | corrector_rule_set.revision |
| Upload writer protocol | upload_session хранит intent, upload_attempt — отдельный object key, provider upload, lease/token и durable progress; checksum/receipt в content_object |
| Origin VERSION_RESTORE | Включён в file_version.origin; восстановление публикует новую версию |
| Актуальность внешнего membership | Требуется deployment integration protocol refresh/expiry; сохранённый roleIds snapshot не является бессрочным разрешением |

MARKERS_CHANGE включён в audit domain. Mapping CUSTOM→pluginId и permissions→bitmask не требует новых справочников. path, latest rule version, resultNodeId копии и effective permissions вычисляются. authorization_revision пространства используется совместно с row-lock барьером для проверки большого export manifest без длинной транзакции.

Модель дополнительно предусматривает VERSION_RETIREMENT и COPY_CONTENT. Отдельный API массового retirement версий и режим замены существующего файла при копировании ещё не добавлены. NewUpload допускает отсутствие expectedSizeBytes или NULL; raw PUT допускает отсутствие Content-Length с серверным byte limit. Каталог движков, effective-permissions API остаётся отдельной доработкой; фильтр статуса ролей и ancestors для навигации включены в текущий контракт.

## Проверка

[tools/validate-openapi.cjs](../tools/validate-openapi.cjs) проверяет YAML/дубли ключей, официальную схему OpenAPI 3.0.x, внутренние ссылки, уникальные operationId, path parameters, auth/permissions, DB-gap пометки и JSON/NDJSON примеры. Пример команды после подготовки локальных validator dependencies:

```powershell
node --preserve-symlinks --preserve-symlinks-main file-manager/tools/validate-openapi.cjs file-manager/contracts/sprut-file-manager-openapi.yaml C:/Users/kulik/AppData/Local/Temp/sprut-openapi-validation-20261008
```

Каталог валидатора содержит `yaml/package` (yaml 2.8.1), `tv4/package` (tv4 1.3.0) и официальную `openapi-3.0-schema.json`. После очистки TEMP требуется подготовка каталога зависимостей либо использование локального валидатора OpenAPI в IDE. Согласованность общей и детальных PUML, ограничения identity/role и единой YAML-конфигурации дополнительно проверяет tools/validate-file-manager-design.cjs.
