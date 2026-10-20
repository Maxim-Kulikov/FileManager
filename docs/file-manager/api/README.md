# Sprut File Manager: минимальные файловые сценарии

Контракт: [OpenAPI](../contracts/sprut-file-manager-openapi.yaml). Context path /sprut-file-manager; пути ниже начинаются /api/v1. [YAML-пример](../architecture/application-file-manager.example.yaml) определяет инфраструктуру; spaces создаются вручную.

PNG алгоритмов находятся в [preview](preview/). Исходники PUML хранятся в текущей папке; изображения при рендеринге записываются в preview.

## Алгоритмы endpoint'ов

| Метод и путь | operationId | Самостоятельный PUML |
|---|---|---|
| POST /api/v1/spaces/{spaceId}/nodes | createNode | [Создание папки или placeholder файла](POST.sprut-file-manager.api.v1.spaces.{spaceId}.nodes_AD.puml) |
| POST /api/v1/spaces | createSpace | [Создание пространства](POST.sprut-file-manager.api.v1.spaces_AD.puml) |
| POST /api/v1/spaces/{spaceId}/uploads | createUploadSession | [Создание намерения загрузки](POST.sprut-file-manager.api.v1.spaces.{spaceId}.uploads_AD.puml) |
| PUT /api/v1/uploads/{uploadId}/content | uploadContent | [Потоковая передача байтов](PUT.sprut-file-manager.api.v1.uploads.{uploadId}.content_AD.puml) |
| POST /api/v1/uploads/{uploadId}/complete | completeUploadSession | [Проверка и публикация загруженного файла](POST.sprut-file-manager.api.v1.uploads.{uploadId}.complete_AD.puml) |
| GET /api/v1/uploads/{uploadId} | getUploadSession | [Состояние и восстановление загрузки](GET.sprut-file-manager.api.v1.uploads.{uploadId}_AD.puml) |
| DELETE /api/v1/uploads/{uploadId} | abortUploadSession | [Отмена неопубликованной загрузки](DELETE.sprut-file-manager.api.v1.uploads.{uploadId}_AD.puml) |
| GET /api/v1/nodes/{nodeId}/children | listChildren | [Переход в папку и список содержимого](GET.sprut-file-manager.api.v1.nodes.{nodeId}.children_AD.puml) |
| GET /api/v1/nodes/{nodeId}/ancestors | getNodeAncestors | [Навигационная цепочка](GET.sprut-file-manager.api.v1.nodes.{nodeId}.ancestors_AD.puml) |
| GET /api/v1/spaces/{spaceId}/nodes/resolve | resolveNodeByPath | [Разрешение legacy logical path в nodeId](GET.sprut-file-manager.api.v1.spaces.{spaceId}.nodes.resolve_AD.puml) |
| GET /api/v1/nodes/{nodeId} | getNode | [Metadata одного файла или папки](GET.sprut-file-manager.api.v1.nodes.{nodeId}_AD.puml) |
| GET /api/v1/nodes/{nodeId}/content | downloadContent | [Просмотр или скачивание содержимого файла](GET.sprut-file-manager.api.v1.nodes.{nodeId}.content_AD.puml) |
| HEAD /api/v1/nodes/{nodeId}/content | headContent | [Заголовки файла без содержимого](HEAD.sprut-file-manager.api.v1.nodes.{nodeId}.content_AD.puml) |
| POST /api/v1/nodes/{nodeId}/move | moveNode | [Перенос узла внутри пространства](POST.sprut-file-manager.api.v1.nodes.{nodeId}.move_AD.puml) |

[Загрузка дерева папок](WORKFLOW.sprut-file-manager.directory-upload_AD.puml) — составной клиентский workflow поверх перечисленных API. Отдельный endpoint directory-upload не вводится. Новые PUML не требуют сетевых includes и проверяются PlantUML 1.2024.8.

## Правила чтения алгоритмов

В схемах указаны получаемые сущности, условия поиска, проверки полей, изменения и результаты. Одна ветка ошибки определяет один HTTP status и один code. Сокращённые общие процедуры ниже являются частью алгоритмов; они не требуют отдельных HTTP-запросов. Имена процедур приводятся в комментарии каждого PUML.

### Обозначения на схемах

- Рамка `TX — PostgreSQL` обозначает транзакционный участок. Указаны назначение и isolation level. При нескольких транзакциях в одном запросе используются TX 1, TX 2 и TX 3.
- COMMIT завершает успешную ветку. ROLLBACK завершает ошибочную ветку. Ранние ответы внутри рамки выдаются после указанного COMMIT/ROLLBACK, а не под продолжающейся транзакцией.
- Передача HTTP body, MinIO I/O и длительная проверка checksum находятся вне рамок. Вызовы общих recovery/lease-процедур могут выполнять собственные короткие транзакции, описанные ниже; рамки не объединяют их в одну длинную TX.
- Блок Request содержит method/path, path/query parameters, headers и поля body. Блок Response содержит успешные HTTP statuses, headers, поля body и структуру ошибки Problem. Обозначения: `*` — обязательное поле, `?` — необязательное, `(null)` — значение может быть null. Отсутствие поля и null не отождествляются.
- Вложенные поля Node.file, NodePage.items, UploadCompleteResult.node/version и initialAccess перечислены непосредственно на схеме. Для HEAD и ответов 204/304 body отсутствует.
- Публичные error codes соответствуют enum `Problem.code` в OpenAPI. Внутренний `last_error_code` попытки может дополнительно уточнять техническую причину.
- Сценарий загрузки дерева показывает клиентские входные данные и результат, а не отдельный REST Request/Response. Транзакции отдельных HTTP-операций не объединяются в транзакцию дерева.

### REQ — общие проверки до начала бизнес-алгоритма

1. Аутентифицировать mTLS/workload caller. Отсутствующая или недействительная identity: 401 `UNAUTHENTICATED`.
2. Проверить caller allowlist и право делегирования actor-контекста. Отказ: 403 `ACCESS_DENIED`.
3. Получить `configuredTenantId` из серверного YAML. Проверить одиночные `X-Actor-Id/Type/Roles/Groups`, формат UUID и допустимые типы. Неверный actor-контекст: 400 `BAD_IDENTITY_CONTEXT`. Заголовки не заменяют проверку caller.
4. Проверить или создать `X-Correlation-Id`, передать trace context в telemetry. Некорректный correlation header: 400 `VALIDATION_ERROR`, с новым безопасным correlation ID в ответе.
5. Проверить UUID path-параметров, типы query/header/body по OpenAPI, неизвестные JSON-поля и обязательные значения. Нарушение: 400 `VALIDATION_ERROR` с `violations`. Отсутствие `If-Match` обрабатывается отдельно в move как 428. Семантические проверки, указанные в схеме, выполняются после структурной валидации.
6. Для JSON проверить фактический размер body: превышение `maxJsonBodyBytes` даёт 413 `REQUEST_BODY_TOO_LARGE`. Это не лимит raw file bytes. PUT content проверяет транспортный Content-Type и размер в собственном алгоритме.
7. Для cookie-authenticated mutations выполнить согласованную CSRF-проверку до изменения данных. REST и MVC используют одну application-логику, но разные transport adapters.

### TREE — технический путь папок

[Модель дерева](../architecture/sprut-file-manager-tree.md): FOLDER хранит tree_path LTREE из UUID-меток; FILE имеет NULL. Метка label(id) = n_ + UUID без дефисов в нижнем регистре. Root path = label(rootId), child FOLDER path = parent.tree_path || label(id). Поле внутреннее, в Request/Response не добавляется.

Для FOLDER предки берутся из tree_path без последней метки; для FILE — из полного tree_path родителя. Папки читаются по UUID в одном space с проверкой порядка, parent links, корня, глубины и статусов. Разрыв/несоответствие — 503 INTERNAL_ERROR без частичной цепочки. Logical path строится по текущим именам, не из UUID-строки.

Direct children выбираются по parent_id; recursive FOLDER — по tree_path <@ root.tree_path с исключением root, FILE — JOIN на parent.tree_path. Проверки tenant/space, ACTIVE ancestors и ACL сохраняются. Обычный порядок FOLDER first/name/id; recursive — id. pageSize не ограничивает работу БД: применяются DB timeout и ресурсные бюджеты.

Create/COPY/restore вычисляют пути в TX из текущего родителя. Rename их не меняет. Move FOLDER обновляет parent_id и все folder prefixes одной TX, включая TRASHED/PURGING; preflight generation сверяется под exclusive space lock. Превышение maxAtomicMoveFolders — 413 RESOURCE_LIMIT_EXCEEDED без изменений. В history/before_state технический prefix не переносится.

### ACL — вычисление текущих прав

1. Получить узел и предков по TREE в том же space/tenant. Проверить соответствие parent_id, UUID-меток и maxDepth. Нарушение — 503 INTERNAL_ERROR, запись operational error. Частичная цепочка не считается успешным результатом.
2. Получить `node_acl` узла и предков с `revoked_at IS NULL`. Учесть расстояние от grant до целевого узла: SELF — только сам узел, CHILDREN — непосредственный ребёнок, SUBTREE — узел и все потомки.
3. Для USER/SERVICE сопоставить subject с actor; для GROUP — с доверенными текущими groups. Для ROLE нужны UUID в actor roles, ACTIVE `access_role` того же space и применимый ACL binding. Permissions читаются из текущего `role_permission`, а не из копии в заголовке.
4. Объединить ALLOW permissions. ADMIN не подразумевает READ, WRITE или platform permission CREATE_SPACE. READ для цепочки предков определяет её видимость. Проверка READ/WRITE/DELETE целевого узла указана в конкретной схеме.
5. Отсутствие видимости возвращает 404 `RESOURCE_NOT_FOUND`. Недостаток требуемого права для уже видимой цели возвращает 403 `ACCESS_DENIED`. TRASHED/PURGING цепочки скрываются в обычных API; исключение — явно указанный `includeTrashed` у resolve, без отключения ACL.

В read-only алгоритмах одна TX `REPEATABLE READ` обеспечивает общий snapshot metadata и ACL. В изменяющих алгоритмах используется `READ COMMITTED`: space lock берётся до чтения текущих grants и сохраняется до commit. Порядок блокировок: space → session, если есть → attempt, если есть → целевые node/file_entry/file_version → content_object. Несколько однотипных строк блокируются в порядке UUID.

### IDEMP — результат изменяющей команды

- Scope содержит tenant, actor type/id, operation и resource IDs, указанные в схеме. Hash строится по нормализованной исходной команде; для move включает исходный If-Match. Вычисленные mutable metadata не подменяют исходную команду в hash.
- `INSERT ... ON CONFLICT DO NOTHING` и результат команды находятся в одной TX. Конкурентный запрос ждёт разрешения конфликта, затем отдельным SELECT читает committed запись. Незавершённая запись без результата не публикуется отдельно.
- Другой hash при том же scope/key: 409 `IDEMPOTENCY_KEY_REUSED`. Совпадающий hash и доступный сохранённый результат: исходные status/body без нового побочного эффекта.
- Если срок replay истёк либо целевой resource физически удалён: 410 `IDEMPOTENCY_RESULT_EXPIRED`. Пока запись сохраняется, истечение не превращает тот же key в разрешение создать новый объект.
- Перед replay повторно проверяются текущие полномочия операции и видимость сохранённого resource. Скрытый результат: 404 `RESOURCE_NOT_FOUND`. Возвращается сохранённый ответ, а не новое текущее состояние; актуальные metadata доступны через GET.

### HIST и INDEX — записи в транзакции изменения

tree_path не записывается в node_revision: история содержит parent/name, технический путь текущей структуры пересчитывается при публикации restore. Производный prefix rewrite вложенных папок не создаёт их metadata revision.

**HIST:** закрыть прежний открытый `node_revision` этого node: `valid_to = txTime`. Вставить новую запись с текущими revision, parent/name/markers/status, file version, actor/operation, `valid_from = txTime`, `valid_to = NULL`. При первом создании закрываемой записи нет. Для папки и FILE placeholder `file_version_id = NULL`. При публикации содержимого новая history revision ссылается на опубликованную версию. `txTime` фиксируется для перехода; номера revision монотонны.

**INDEX:** UPSERT `search_index_task` по `(space_id, node_id, task_scope)` с action UPSERT и максимальным `desired_revision`. Для NODE это `fs_node.search_revision`; для SUBTREE — поколение structural change `storage_space.authorization_revision`. Новая запись: PENDING, attempt/token = 0, next_attempt_at = updated_at = txTime. У существующей RUNNING записи сохраняются действующие lease и processing revision; worker после I/O замечает новую desired revision и не теряет изменение. Неактивная задача с новой revision возвращается в PENDING. Внешний OpenSearch I/O не выполняется в HTTP-транзакции.

Audit содержит resource/operation IDs, tenant, actor/caller, correlation/trace и безопасный before/after snapshot. Секреты и raw file bytes не записываются. Audit, история и index intent фиксируются с основной mutation, а не отдельным best-effort вызовом.

### UPLOAD_ACCESS — цель и доступ к сессии

1. Найти `upload_session` по uploadId через space с `tenant_id = configuredTenantId`. Tenant другой записи не раскрывается.
2. Для активной NEW-сессии цель — `target_parent_id` (FOLDER). Для UPDATE — `file_node_id` (FILE). Для COMPLETED — текущий файл версии `result_version_id`, даже если после публикации он был перемещён. Неверный тип target означает нарушение сохранённого intent, 503 `INTERNAL_ERROR`.
3. Получить target и предков, проверить ACTIVE и видимость цепочки. Отсутствующая/скрытая цель: 404 `RESOURCE_NOT_FOUND`. Для управления сессией требуется её `created_by = actorId` либо ADMIN на target; отказ скрывается через 404. GET дополнительно требует READ на target; PUT/complete/DELETE — WRITE.
4. Для изменяющего запроса первоначальное чтение определяет только space ID. После space lock повторно прочитать session FOR UPDATE. Если запись исчезла: 404 `RESOURCE_NOT_FOUND`. Повторить tenant/target/ACL проверки под блокировкой. Получение результата GET и completed replay не меняет TTL или current pointer.
5. Проверка срока — фактическое `expires_at <= now` в БД. Для активной сессии она запрещает PUT/finalize даже до запуска expiry worker. COMPLETED replay проверяется раньше TTL; истечение исходного upload TTL не отменяет опубликованный результат. GET возвращает сохранённый status, expiry worker обновляет его отдельно.

### REPLAY_UPLOAD — повтор завершённой публикации

Прочитать `file_version` по `result_version_id` этой session и её `content_object`. Отсутствующая или RETIRED result version: 410 `VERSION_EXPIRED`. Если checksumSha256 передан и отличается от сохранённого checksum результата: 422 `CHECKSUM_MISMATCH`. Иначе вернуть 200 `UploadCompleteResult`: исходную опубликованную version и актуальный Node, не присваивая эту version в `file_entry.current_version_id` повторно. Проверка выполняется в обоих completed branches схемы complete. До VERIFIED receipt проверяются фактические размер/SHA-256 объекта против receipt PUT и против expected size/checksum при их наличии. Multipart ETag не считается SHA-256.

### FAIL_TRANSFER и CLEANUP — ошибка попытки и физическая очистка

**FAIL_TRANSFER:** остановить внешний I/O. В короткой TX заблокировать space → session → attempt. Менять attempt разрешено только при совпадении session.current_attempt_id, attemptId и lease token. Для своей незавершённой попытки записать FAILED, finished_at, last_error_code и очистить lease. Активную session с неистёкшим TTL вернуть в UPLOADING, чтобы разрешить новый PUT. Не изменять ABORTED/EXPIRED/COMPLETED session и новую попытку. Для старого object сохранить CLEANUP intent независимо от возможности изменить current attempt. COMMIT. Ошибка фиксации в БД передаётся в ERR; HTTP-ошибка не доказывает, что cleanup receipt сохранён.

**CLEANUP:** в `gc_task` сохранить space, task type, стабильный target ID и exact `target_snapshot` с bucket/key/provider version/upload ID без credentials. Для ABORT_MULTIPART target — конкретный attempt ID, для DELETE_OBJECT — content object ID. Новая задача PENDING, attempt/token = 0, с delete_not_before после grace. При неизвестном provider upload ID сохраняется object-scoped reconciliation intent; поздний receipt старого writer обнаруживается сверкой. Worker перед физическим удалением под object lock повторно проверяет все references/holds и переводит объект в GC_PENDING. Живой опубликованный объект не удаляется по одному лишь наличию cleanup task. API не ожидает завершения MinIO cleanup.

### ERR — общие ошибки и границы ответа

- Любая ветка ошибки внутри незавершённой изменяющей TX выполняет ROLLBACK, если в схеме явно не зафиксирован отдельный recovery transition. БД недоступна/временная инфраструктурная ошибка: 503 `DEPENDENCY_UNAVAILABLE`. Неожиданное исключение: 500 `INTERNAL_ERROR`.
- Отсутствие обязательной связанной записи после нахождения основной сущности: 503 `INTERNAL_ERROR` и operational alert. Отсутствие выбранной пользователем версии — обычный 404, показанный в схемах.
- Несовпадение общих YAML targets с сохранённым размещением: 503 NOT_CONFIGURED; YAML не перенаправляет существующие пространства в другое хранилище.
- Ошибка до отправки HTTP headers возвращает Problem по контракту. После начала raw response передача прекращается, JSON и новый status не добавляются. HEAD всегда возвращает ответ без body, включая ошибки.
- Потеря ответа после COMMIT не означает отсутствие результата. Повтор использует исходный key или uploadId. PUT не повторяется вслепую: сначала GET session. HTTP 408 в PUT означает истечение deadline приёма body, 503 — сбой зависимой системы; при disconnect ответа нет.

## Разделение операций

- POST nodes FOLDER создаёт только metadata папки без S3 marker.
- POST nodes FILE создаёт placeholder: currentVersionId=NULL, contentRevision=0. Это не опубликованный файл 0 bytes.
- Реальный пустой файл: uploads NEW с expectedSizeBytes=0 → PUT пустого body → complete. Непустой файл проходит тот же протокол с bytes.
- Для placeholder используется uploads UPDATE с baseVersionId=NULL и expectedContentRevision=0. Для существующего файла — current base/revision; независимые rename/markers не подменяют content CAS.
- Имя и parent задаются отдельно. Upload не принимает абсолютный путь, bucket и object key. Для дерева клиент создаёт parents и использует полученные IDs.
- Навигация — GET children/ancestors. POST move изменяет структуру дерева и имеет собственные WRITE/DELETE/CAS проверки.

## Общий контекст и транзакции

Gateway проверяет token и заменяет X-Actor-*; File Manager проверяет доверенного caller. Tenant берётся из YAML. Все операции проверяют space/ancestor visibility и текущие ACL/ACTIVE роли; headers не являются самостоятельным доказательством доверия. Correlation ID проверяется или создаётся и возвращается в ответах.

Изменяющий сценарий выполняет короткую PostgreSQL TX с общим DataSource. Space lock сериализует локальные ACL/role изменения с публикациями. Структурные create/rename/move/trash/restore и NEW upload publication берут exclusive space lock и увеличивают authorization_revision; UPDATE content publication использует shared lock. Для глубокого move depth preflight выполняется вне TX с проверкой неизменного поколения при commit; нестабильное дерево даёт bounded retry/409, не длинную блокировку. Freshness внешних memberships требует отдельно утверждённого протокола.

S3 I/O, передача HTTP body и checksum verification выполняются вне длительной TX. Новый attempt имеет новый object key; старый writer не может публиковать по устаревшему token. Verify receipt и логическая публикация — разные стадии.

Gateway проксирует raw body потоково, без полного накопления в RAM и без неявного retry непрокручиваемого PUT. JSON body limit отделён от raw file byte limit; disconnect/timeout не доказывает отсутствие receipt. Cookie-authenticated mutations защищаются согласованным CSRF-протоколом до изменения состояния, в том числе при raw upload.

Idempotency-Key обязателен для createNode/createSpace/createUpload/move. Scope включает tenant+actorType/ID+operation/resource; hash — нормализованную команду. После потери ответа сначала выясняется состояние существующего ресурса. Повтор complete естественно идемпотентен по session. Ошибка/timeout не доказывает отсутствие commit.

## Upload: ограничения и recovery

expectedSizeBytes и Content-Length опциональны; NULL/отсутствие означает неизвестную заранее длину. Лимит maxFileBytes проверяется по фактическому потоку. Отрицательные размеры запрещены; заданные длина/checksum проверяются. Отсутствие Content-Length не означает пустой файл.

GET Upload возвращает status session и snapshot uploadedBytes текущего attempt. Пока активен writer — новый PUT получает 409. После failed/expired attempt в живой session новый PUT создаёт отдельный attempt/key. После полного receipt повтор PUT отклоняется; используется complete. Клиентское возобновление по offset и multipart parts API не поддерживаются.

Verification может вернуть 202; клиент продолжает GET session и повтор complete. Завершённая session возвращает свой устойчивый result_version_id, даже если currentVersionId файла уже изменился позднее. Опубликованный результат не удаляется через DELETE session.

## Папка с файлами

Discovery локального дерева выполняется batches, не одним гигантским manifest/body. Сохраняется mapping relative folder→nodeId и журнал uploadId/result. Число одновременных streams ограничено server/client budgets.

Default collision policy — FAIL. Объединение папок либо замена файла допускаются только как явно выбранный режим клиента: существующий folder проверяется после resolve; overwrite использует UPDATE upload с CAS. После 409 нельзя молча выбрать другой файл или перезаписать current.

Пустые папки сохраняются при наличии directory entries. Browser FileList с файлами не позволяет восстановить отсутствующие empty directories. ZIP import и symlinks не входят в этот workflow.

Частичный результат допустим: успешные siblings остаются при ошибке одного файла. Отмена останавливает новые запросы и abort неопубликованные sessions; опубликованные файлы/папки не откатываются автоматически. Серверного batch jobId нет; job cancel API к этому сценарию не применяется. Возобновление после потери client journal требует повторного выбора локальных файлов и безопасного сопоставления существующих результатов.

## Навигация и просмотр

1. GET spaces → выбрать space/rootNodeId.
2. GET nodes/rootId/children → отображать items по nodeId, parentId, type, markers.
3. Открыть folder → children/folderId; breadcrumbs → ancestors; path-based deep link → resolve.
4. Открыть FILE → GET Node metadata → GET content, при необходимости сначала HEAD/ограниченный Range.

children использует PostgreSQL и keyset cursor, не eventual OpenSearch. Cursor связан с tenant/query; фильтры не меняются при продолжении. Concurrent moves/renames не создают global snapshot; UI дедуплицирует IDs. Для большого обхода используется существующий children/stream NDJSON.

Resolve выбирает ACTIVE sibling по нормализованному имени. При `includeTrashed=true` и отсутствии ACTIVE допускается TRASHED sibling. Несколько TRASHED candidates дают 409 `PATH_INVALID`; произвольный выбор удалённого узла не выполняется. PURGING узлы не разрешаются.

Чтение bytes фиксирует immutable version и bounded CONTENT_READ hold. Если HTTP headers уже отправлены, ошибка означает обрыв body, не JSON в конце файла. Без Range пустой файл даёт 200/Content-Length=0; некорректный диапазон — 416. Текст отображается безопасным text renderer с charset версии; HTML/JS файла не исполняется. HEAD не читает bytes и не отправляет body.

## Соответствие legacy

| Legacy ProxyS3Controller | Новый сценарий |
|---|---|
| PUT /api/s3/bucket/folder | POST nodes FOLDER; без marker object |
| PUT /api/s3/bucket/file | NEW upload → PUT → complete; запрет неявной перезаписи |
| PUT /api/s3/bucket/object/path | UPDATE upload с content CAS |
| GET /api/s3/bucket/objects | GET children, recursive=false |
| GET /api/s3/bucket/objectsRecursive | GET children recursive=true либо NDJSON |
| GET object?key/versionId и object/path | Resolve logical path → GET content по node/version ID |
| Путь upload содержит implicit directories | Явное создание parents в составном directory workflow |

Источники: [ProxyS3Controller](D:/sprut/sprut-web-service/src/main/java/ru/vtb/rkk/domain/controller/ProxyS3Controller.java), [S3Controller](D:/sprut/sprut-web-service/src/main/java/ru/vtb/rkk/domain/controller/S3Controller.java). Legacy bucket/key IDs не переносятся как разрешение на прямые physical writes.

## Проверки реализации

- Два create одной sibling name: один успех, второй 409; повтор Idempotency-Key возвращает первый результат.
- Реальный файл 0 bytes и placeholder дают разные состояния чтения.
- Неизвестная длина, превышение maxFileBytes, disconnect, неверный checksum и потеря ответа после commit.
- Два PUT, истёкший lease, старый receipt после нового attempt, complete одновременно с abort.
- Частичная directory upload, empty directories, folder/file collision и overwrite CAS conflict.
- Полный listing с pagination, cursor mismatch, rename/move между страницами и недоступный ancestor.
- Корректные 200/206/304/416, Range пустого файла, безопасный preview и отсутствие утечки недоступных versions.
- Два конкурирующих move не создают цикл; stale metadata revision не переносит узел; S3 keys не меняются.

Проверки выполняются интеграционными и конкурентными тестами.
