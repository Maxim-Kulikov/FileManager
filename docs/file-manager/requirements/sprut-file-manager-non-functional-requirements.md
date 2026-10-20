# sprut-file-manager: нефункциональные требования

Связанные документы:

- [Функциональные требования](sprut-file-manager-functional-requirements.md).
- [Полная модель PostgreSQL](../database/sprut-file-manager-db-all.puml).

## 1. Методика проверки требований

Для нагрузочных тестов фиксируются профиль нагрузки, размер данных, инфраструктура, длительность прогона и условия ошибок.

Проверяются хвостовые задержки, корректность при конкуренции, рост очередей, восстановление и пределы ресурсов.

## 2. Архитектурные ограничения

### NFR-001. Единый владелец данных

File Manager является одним логическим микросервисом. PostgreSQL/schema, S3 namespace и поисковая проекция управляются им.

API и worker могут развёртываться отдельно. Количество deployments не меняет владение данными.

Проверка: внешние сервисы не имеют штатного WRITE-доступа к его domain tables и объектам; все изменения проходят через согласованный контракт.

### NFR-002. Durable PostgreSQL-очереди

Discovery, bulk items, search tasks и GC tasks сохраняются в PostgreSQL. Kafka, локальный executor и RAM не являются источником истины о незавершённой работе.

Используется резервирование пачки через SKIP LOCKED либо эквивалентный корректный протокол, lease и fencing token.

LISTEN/NOTIFY, если используется, только ускоряет пробуждение: потеря notification не приводит к потере задания. Polling/reconciliation обеспечивает продолжение.

Проверка: принятый job продолжается после остановки всех application replicas и их последующего запуска.

### NFR-003. Короткие транзакции

Сетевой S3/OpenSearch I/O, чтение больших файлов и исполнение выражений выполняются вне длительных PostgreSQL-транзакций.

Claim/heartbeat/finalize/commit ограничены небольшим набором строк. Протокол фиксирует порядок блокировок job/item/node/version/object для снижения deadlocks.

Atomic move папки переписывает не более maxAtomicMoveFolders путей, включая TRASHED/PURGING; preflight выполняется вне изменяющей TX и проверяется по authorization_revision под exclusive lock. Превышение отклоняется без частичного изменения. Пакеты UPDATE не имеют промежуточных COMMIT. Лимит подбирается по времени блокировки, WAL и стоимости индексов; значение из YAML не является гарантией latency.

Проверка: медленный S3 запрос не держит row locks и connection на всё время передачи файла.

### NFR-004. Изоляция ресурсов процессов

Тяжёлые transform/regex не выполняются в HTTP request threads. API и bulk-worker имеют отдельные CPU/memory limits и DB pools.

Начальный вариант допускает API + worker. При необходимости maintenance/indexing выделяется в независимый профиль того же сервиса.

Проверка: CPU-intensive job при заданном лимите workers не нарушает согласованное SLO metadata API.

## 3. Нагрузка и capacity

### NFR-005. Capacity model

До утверждения размеров инфраструктуры измеряются:

| Параметр | Что нужно определить |
|---|---|
| Tenant/spaces | Количество, размер крупнейшего space и число активных одновременно |
| Namespace | Всего узлов, глубина дерева, max children одной папки |
| Содержимое | Общий объём, p50/p95/max размера файла, доля text/JSON/binary |
| Версии | Изменений в день, retained versions, доля общих content objects |
| Jobs | Запусков в час, items/job, одновременно активных job |
| Transform | Сложность regex/JSON, CPU на MB, output expansion |
| I/O | Download/upload bandwidth, concurrency, archive workloads |
| Поиск | Запросов в секунду, indexed text bytes, размер выдачи |
| PostgreSQL | Claim/commit в секунду, table/index growth, WAL и connection budget |

Наличие гигабайтов байтов не означает гигабайты RAM. DB load оценивается отдельно по числу узлов, версий, items и частоте транзакций.

Проверка: результаты capacity study привязаны к перечисленным величинам, а не только к размеру bucket.

### NFR-006. Предварительные нагрузочные сценарии

Предварительные контрольные наборы; ограничения продукта определяются отдельно:

- Большая папка: 100 000 прямых детей.
- Большое дерево: 1 000 000 узлов со смесью глубины/ширины.
- Bulk job: 100 000 и 1 000 000 items, суммарно от 10 до 100 GB.
- Несколько spaces и job с пересекающимися roots в одном tenant; изоляция разных tenant проверяется отдельными развёртываниями/тестовыми контекстами.
- Множество малых файлов и отдельные большие файлы — раздельные тесты.
- Read/write API выполняется одновременно с transform, indexing и GC.
- Нагрузка discovery выше скорости обработки, затем обратный режим.

RPS, размеры отдельных файлов, число concurrent jobs и профиль инфраструктуры требуют определения. Срок обработки миллиона items подтверждается нагрузочными испытаниями.

### NFR-007. Ограниченная память

Discovery, listing, export и GC используют ограниченные страницы/буферы. Накопление полного списка путей или содержимого задания в RAM запрещено.

Concurrency и buffer sizes настраиваются. Для expression engine задаются максимальный размер входа, output expansion, CPU/time и memory budget.

Regex/JSON над большим файлом не объявляется потоковым без проверки семантики: совпадения через границы chunk и полный parse требуют корректного алгоритма или ограниченного disk spill.

Проверка: рост дерева с 100 тысяч до миллиона узлов не вызывает пропорциональный рост heap discovery worker. Неподдерживаемый размер входных данных приводит к контролируемому отказу item без OOM сервиса.

### NFR-008. Backpressure, квоты и справедливость

Настраиваются max active jobs/items на tenant/space/job, max queue growth, upload concurrency и byte/storage quotas.

Исчерпание квоты хранилища или лимита активных заданий возвращает HTTP 409 с кодом QUOTA_EXCEEDED либо TOO_MANY_ACTIVE_JOBS соответственно. Ограничения вычислительных ресурсов и размера запроса имеют отдельные коды ошибок.

Распределение worker slots обеспечивает обслуживание нескольких jobs без монополизации ресурсов одним заданием. Лимит резервируется атомарно; повторный claim и lease reclaim не обходят его.

Discovery ограничивает опережение обработки при росте manifest. Ограничения учитывают разные размеры файлов, а не только число items.

Проверка: большое задание одного space не блокирует навсегда маленькие задания другого space обслуживаемого tenant; при перегрузке выдаётся устойчивое поведение admission control.

### NFR-009. Индексы и обслуживание очередей

Поддерживаются индексы eligibility, lease expiry, job/status и checkpoints. Claim не выполняет full scan всей истории завершённых items.

Дерево использует ltree и GiST по tree_path папок, B-tree для parent/id и обычной сортировки имён. Измеряются recursive listing через parent JOIN, отбор TEST_CASE, проверка предков и изменение prefix. GiST не гарантирует O(pageSize): проверяются кандидаты, сортировки, ACL и план EXPLAIN (ANALYZE, BUFFERS).

Batch sizes подбираются экспериментально. Контролируются WAL, autovacuum, dead tuples, table/index bloat и время удержания locks.

Индексы не заменяют retention. Partitioning вводится при обоснованной необходимости и с учётом PostgreSQL PK/FK/UNIQUE, а не механическим переносом схемы audit в queue.

Проверка: EXPLAIN ANALYZE на репрезентативных больших таблицах подтверждает план; soak test не показывает неограниченный bloat.

## 4. Предварительные SLO

### NFR-010. Численные цели

Значения проверяются нагрузочными тестами на заданном workload.

| Показатель | Предварительная цель | Условия измерения |
|---|---|---|
| Доступность основного API | 99,9% в месяц | Раздельно учитывать metadata и content operations; согласовать исключения |
| Чтение metadata / страницы до 100 записей | p95 ≤ 300 ms; p99 ≤ 1 s | Без передачи содержимого файлов, при нормальной нагрузке |
| Короткая namespace mutation | p95 ≤ 500 ms; p99 ≤ 1,5 s | Включая PostgreSQL commit, без массового copy/export |
| Принятие durable job | p95 ≤ 1 s | Валидация команды и roots; без полного discovery |
| Приём cancel | p95 ≤ 500 ms | До commit CANCEL_REQUESTED; lock contention включён |
| Видимость progress | Отставание ≤ 5 s | Может быть cached, terminal status проверяется отдельно |
| Индексация обычного изменения | p95 lag ≤ 10 s | OpenSearch доступен, очередь ниже согласованного порога |
| Lease duration / heartbeat | 60 s / не реже 20 s | Предварительная конфигурация, с jitter и server time |
| Reclaim зависшего item | ≤ 120 s после последнего heartbeat | PostgreSQL доступен и есть свободный worker |
| RPO восстановления PostgreSQL | ≤ 5 min | Disaster recovery, отдельно от обычного падения worker |
| RTO сервиса после disaster | ≤ 60 min | При согласованном объёме/инфраструктуре и проверенном runbook |

Объёмные download/upload, завершение bulk job, ZIP и время GC не имеют одного универсального latency target. Их SLA выражается через выбранный объём, сложность, throughput, backlog age и dependency health.

### NFR-011. Методика SLI

Latency измеряется сервером и, отдельно, end-to-end клиентом. Ошибки доступа/валидации не маскируются под отказ сервиса, но неожиданные конфликты/таймауты учитываются по согласованной методике.

Отдельно считаются ожидание в очереди, активная обработка, S3 I/O и commit latency.

Оценка состояния очереди учитывает возраст незавершённых заданий независимо от latency ответа 202.

Проверка: dashboards позволяют отличить slow API, overloaded queue и slow S3/OpenSearch.

## 5. Целостность и конкурентность

### NFR-012. Согласованность authoritative данных

Namespace, current version, item result, retained history и ACL изменяются через локальные ACID-транзакции и проверяемые инварианты.

Путь не вычисляется из S3 key. Поиск не используется для окончательной проверки версии/доступа.

После успешной mutation API обеспечивает чтение своего результата через primary либо другой явно согласованный read-your-writes механизм. Replica lag не должен выглядеть как потеря созданного файла.

Проверка: конкурентные/failure tests не обнаруживают current pointer на версию другого файла или orphan metadata текущей версии.

### NFR-013. CAS и отсутствие lost updates

Публикация содержимого проверяет ожидаемые versionId/contentRevision; структурная операция — revision и инварианты affected parents. Замена массива markers проверяет revision узла в той же транзакции с записью metadata/history/audit/index task, без изменения content_revision.

Проверка версии и её смена входят в одну транзакцию. Перед этим проверяется актуальная авторизация. Параллельные папки не блокируются глобальным lease всего space только ради корректоров.

Проверка: управляемые гонки save/save, save/corrector, move/move, corrector/rollback, markers/markers и markers/rename не теряют чужие изменения.

### NFR-014. At-least-once обработка и единственная публикация

Повтор физического исполнения допустим при lease expiry/crash. Повтор бизнес-публикации одного item не допустим.

LeaseToken проверяется при heartbeat и commit; истёкший lease не продлевается прежним worker после передачи другому владельцу.

Idempotency не ограничивается локальным cache. Инвариант поддерживается PostgreSQL.

Проверка: stale worker после длительной паузы не публикует результат, даже если он закончил upload.

### NFR-015. Линеаризация отмены

Cancel и worker commit сериализуются на согласованном DB-протоколе. После commit CANCEL_REQUESTED у job нет новых публикаций результата.

Отмена не гарантирует немедленного прекращения выполняющегося сетевого вызова. Подготовленные, но не опубликованные объекты не становятся доступными и позже очищаются.

Проверка: failure/concurrency test фиксирует cancel boundary и не находит более поздних публикаций этого job.

### NFR-016. Фиксация команды и воспроизводимость

Snapshot правил, engine version и динамических параметров неизменяемы. Обновление сервиса не должно незаметно менять semantics продолжающегося job.

Старая engine version либо поддерживается, либо job приостановлен технически/завершён с явной ошибкой совместимости. Молчаливое использование новых правил запрещено.

Проверка: один item при retry на другой реплике получает тот же вычисленный результат для тех же base bytes и зафиксированных параметров.

### NFR-017. Ограниченная модель snapshots

Обычный bulk discovery фиксирует версии по мере обнаружения. Требование «все файлы строго на момент начала job» не считается реализованным без отдельного snapshot механизма.

Point-in-time restore использует retained temporal history. Исторические интервалы не пересекаются; timestamps имеют timezone и определённую точность/семантику.

Точное соответствие wall-clock T глобальному commit нескольких узлов остаётся открытым вопросом. История отдельных узлов не обеспечивает атомарный global snapshot.

Проверка: контракты API, UI и тесты используют одну и ту же модель времени.

## 6. Отказоустойчивость и восстановление

### NFR-018. Падение application процесса

Падение API/worker не теряет уже durable принятую работу. Lease reclaim, повторная финализация и reconciliation продолжают workflow.

Состояние не зависит от локального scheduler/cache одной реплики.

Проверка: kill процесса на каждом ключевом шаге claim/transform/upload/commit/discovery приводит к допустимому устойчивому результату.

### NFR-019. PostgreSQL недоступен

Сервис не подтверждает новые mutations/job как успешные без authoritative commit.

Worker при потере DB не публикует результат позже без повторного подтверждения действующего lease, job state и CAS.

Сетевой timeout DB commit рассматривается как неопределённый результат: перед retry проверяется durable состояние/idempotency.

Проверка: разрыв соединения во время commit не создаёт две версии или два задания.

### NFR-020. S3 недоступен

Metadata API может продолжать работать в пределах своих зависимостей. Content operations возвращают явную temporary failure; фоновые items получают bounded retry.

Upload timeout не доказывает отсутствие объекта. Reconciliation проверяет результат и checksum до повторной публикации/очистки.

Проверка: восстановление S3 позволяет продолжить job; массовая временная ошибка не создаёт бесконечный цикл новых objects.

### NFR-021. OpenSearch недоступен

Сохранение/rename/корректоры не зависят от успешной синхронной индексации. Search API явно сообщает деградацию.

Ограничиваются backlog и retry; storage limits не обходятся бесконечным накоплением index tasks.

Проверка: после outage очередь догоняет актуальное состояние без устаревшего текста и resurrected documents.

### NFR-022. Retry policy

Для временных ошибок задаются exponential backoff, jitter, max attempts и/или deadline. Deadlocks допускают ограниченный повтор короткой транзакции.

Ошибки конфигурации, повреждённого input, FORBIDDEN и CAS conflict не повторяются бесконечно как temporary infrastructure errors.

Проверка: временная зависимость не получает retry storm от всех worker одновременно; permanent error становится терминальным результатом.

### NFR-023. Health и graceful shutdown

Readiness API отражает способность обслуживать согласованный набор операций. Недоступность OpenSearch не должна автоматически выводить из readiness всё API, если metadata mutations работают.

Worker прекращает новые claims при shutdown, завершает безопасные короткие операции либо оставляет lease для reclaim. Liveness не рестартует процесс только из-за долгого корректного job.

Проверка: rolling restart не теряет manifest и не превращается в повторную публикацию.

### NFR-024. Backup и disaster recovery

Для PostgreSQL определяются base backups, WAL/PITR, резервное размещение, сроки и регулярные restore drills. Для S3 отдельно проверяется долговечность/репликация и восстановление удалённых объектов в доступном окне.

OpenSearch восстанавливается из authoritative DB + доступных current bytes. Один только replay уже очищенных событий не считается гарантированным rebuild.

Восстановление согласует поколения DB/S3/index, инвалидирует старые leases/запущенных writers и проверяет references. Возврат DB к прошлому состоянию не должен позволять старому живому worker использовать прежний token.

Проверка: restore drill измеряет реальные RPO/RTO и проверяет чтение current versions, задания, holds, watermark и поиск.

## 7. Retention и безопасность очистки

### NFR-025. Reachability вместо возраста

GC не выбирает версию только по createdAt. Учитываются current pointers, retained history, minimum versions, holds, uploads, jobs и совместное использование объектов.

Приоритет защиты данных сильнее целевого срока очистки. Просроченный GC — сигнал обслуживания; удаление живого объекта — нарушение корректности.

Проверка: старый current object не удаляется; shared object копии/restore переживает очистку других file_version.

### NFR-026. Гонки GC и новых ссылок

Создание hold/ссылки и retirement/GC_PENDING сериализуются. Транзакционная проверка reachability и изменение lifecycle не имеют окна TOCTOU.

После GC_PENDING новый reader/job/copy не может получить ссылку на уже удаляемый объект. Конкретный providerVersionId учитывается при native S3 versioning.

Проверка: управляемая гонка GC/restore/copy/hold даёт либо безопасную ссылку, либо отказ, без доступной версии с удалёнными байтами.

### NFR-027. Ограниченное хранение metadata

Для queue history, cursors, sessions, holds, idempotency и audit определены retention/cleanup. Временные FK учитываются протоколом очистки и не препятствуют удалению истёкших служебных записей.

Сохранение summary job после очистки items не создаёт видимость всё ещё доступного пофайлового rollback. Audit не заменяет удалённые bytes.

Проверка: после нескольких retention cycles рост данных соответствует входящему объёму и установленной политике, а не числу запусков за всё время.

### NFR-028. Ограниченное хранение поисковых данных

Основной индекс хранит текущие документы. Historical search не вводится автоматически.

Tombstones и legacy documents имеют безопасный lifecycle. Старый delayed writer не может воскресить документ после физического purge.

Проверка: число основных документов связано с текущим namespace и служебными tombstones, а не с общим числом file versions.

### NFR-029. Наблюдаемость очистки

Измеряются eligible/reclaimed bytes, pending GC age, failed tasks, active/released holds, orphan age и расхождение ожидаемого/фактического storage.

Существенное irreversible удаление имеет audit и traceable task. Должен быть способ временно остановить GC при инциденте, не останавливая чтение и safe mutations.

Проверка: оператор может объяснить, почему версия retained или почему её object удалён.

## 8. Доступ и безопасное выполнение

### NFR-030. Проверка доступа на всех путях

Аутентификация и tenant/space/ACL проверки обязательны для HTTP API, worker commits, presign, search snippets, versions, archives и административных операций.

Проверка пользовательского Bearer token выполняется gateway; File Manager проверяет аутентифицированного caller и доверенный actor-контекст по FR-050/NFR-043. Tenant берётся из YAML по FR-049/NFR-042. Worker использует сохранённого инициатора и действующие ACL; сохранённый snapshot разрешений не предоставляет бессрочный доступ.

Фоновый job не работает с бессрочными полномочиями создателя. Отзыв доступа учитывается по документированному протоколу перед commit.

Кэш ACL не позволяет публиковать новое изменение по отозванному разрешению. Сериализация ACL changes и mutation требует конкретного implementation protocol.

Проверка: negative authorization tests покрывают прямые ID, path/prefix, версии, descendants и metadata job.

### NFR-031. Секреты и каналы передачи

S3/OpenSearch/DB credentials хранятся в инфраструктурном secret mechanism и не выдаются обычному пользователю.

Соединения защищаются согласно инфраструктурной политике. Application и maintenance получают минимально необходимые permissions; public bucket access не является штатным способом чтения.

Logs/errors/audit не содержат access keys, authorization headers, presigned signatures или содержимого файлов.

Проверка: secret scanning telemetry и negative access tests не выявляют утечек.

### NFR-032. Presigned URL

TTL, доступные методы, максимальный размер upload и связанные ограничения задаются явно. Предлагается короткий TTL; конкретное число остаётся TBD.

Контракт описывает остаточное окно доступа после отзыва ACL: стандартная ранее выданная URL может оставаться пригодной до истечения срока.

Немедленный отзыв требует proxy либо другого механизма контроля доступа; стандартная presigned S3 URL этой гарантии не обеспечивает.

Проверка: ссылка не позволяет выбрать другой object/version или продлить TTL произвольным параметром.

### NFR-033. Ограничения expression engine

Кастомные выражения используют разрешённый DSL/зарегистрированные plugins с validation, versioning и resource budgets.

Regex и plugins ограничены по времени, памяти, размеру output и доступным возможностям. Timeout прекращает либо изолирует вычисление; отмена Future без остановки выполняющегося вычисления недостаточна.

Новые plugins проходят отдельную процедуру допуска и compatibility tests. Пользователь не загружает произвольный executable код в API.

Проверка: pathological regex/JSON и output explosion завершают item контролируемо, без остановки API и соседних jobs.

### NFR-034. ZIP, пути и пользовательские имена

Предотвращаются path traversal, обход EXCLUDE через альтернативную запись пути и выход ZIP entries за корень архива.

Нормализация пути задаёт разделитель, Unicode/case policy и обработку пустых/dot segments. Ограничения ZIP/архива включают выходной объём, число entries и временное хранилище.

Проверка: специальные имена и неверные paths не обращаются к OS filesystem или другому space.

## 9. Наблюдаемость и эксплуатация

### NFR-035. Метрики

Необходимые группы:

- API: request rate, p95/p99 latency, errors по операциям.
- Jobs: active, oldest queued age, discovery rate, items/sec, outcomes, cancellation latency.
- Leases: expirations, reclaim, lost ownership, stale commit rejection.
- PostgreSQL: connections, locks, deadlocks, transactions, WAL, bloat, queue query latency.
- S3: bytes/sec, latency, errors, multipart/orphans, integrity failures.
- Search: lag, backlog, failed indexing, rebuild progress.
- GC: pending age, reclaimed bytes, eligible objects и retained holds.
- Quotas: usage, отказ в приёме, tenant fairness и resource saturation.

Проверка: тревога о росте backlog возникает до исчерпания диска/DB capacity.

### NFR-036. Логи, correlation и распределённая трассировка

Структурированные логи включают correlationId, configured tenantId, actorId/actorType, аутентифицированного caller и, при наличии, traceId/spanId. Для фоновой работы дополнительно фиксируются jobId/itemId/attempt/leaseToken. Диагностические значения не используются для авторизации. Пользовательский correlationId не считается уникальным или доверенным доказательством происхождения операции.

correlationId переносится отдельно от tracing headers. Инструментация HTTP-клиентов и executor-контекстов проверяется интеграционными тестами. Наличие записи ID в MDC не считается подтверждением передачи по сети или через асинхронную границу.

На границе PostgreSQL-очереди контекст сохраняется durable и восстанавливается worker явно. Каждый attempt получает собственный span; после длительного ожидания или перезапуска допускается новая trace со ссылкой на исходный контекст. Нельзя удерживать один HTTP span открытым на весь срок задания. Даже при sampling, истечении retention трассировок или недоступности tracing backend связь работы сохраняется через correlationId/jobId/itemId.

После завершения запроса, item или attempt контекст thread-local/MDC очищается в finally. Конкурентные jobs, thread pools и reactive execution не должны смешивать correlationId и identity разных операций. Сохранённые tracing timestamps/spans не восстанавливаются как продолжающаяся старая операция.

Проверяется формат и длина X-Correlation-Id по FR-051; произвольные значения не попадают в логи до валидации. Не допускаются CR/LF injection, неконтролируемый baggage и включение секретов. Свободный ввод correlationId нельзя технически проверить на отсутствие персональных данных; контракт запрещает их передачу, а доступ и retention диагностических данных ограничиваются инфраструктурной политикой.

Идентификаторы высокой cardinality не используются как бесконтрольные metric labels. Подробный trace всего миллионного задания ограничивается sampling.

Недоступность tracing backend не блокирует публикацию бизнес-результата; exporter имеет bounded buffers и timeouts. Потеря span не означает потерю job. Аудит и durable контекст не заменяются best-effort tracing storage.

Проверка: HTTP propagation, отсутствующий/некорректный ID, параллельные запросы, reactive/thread-pool переключения, crash/retry worker и недоступность tracing backend сохраняют корректную изоляцию и связь операций. Один job обнаруживается по jobId независимо от количества traces.

### NFR-037. Runbooks и административные действия

Описываются восстановление lease, stalled FINALIZING, manual retry, index rebuild, остановка GC, missing content object, quota exhaustion и disaster recovery.

Административное действие проверяет полномочия, фиксируется в audit и не обходится прямым ручным UPDATE без понятной процедуры.

Проверка: оператор восстанавливает заданный injected failure по runbook с известным результатом.

## 10. Развёртывание, совместимость и миграция

### NFR-038. Эволюция схемы и jobs

Изменения БД и job schema поддерживают согласованное окно совместимости старых/новых replicas при rolling deployment.

Используется последовательность expand → deploy compatible code → migrate → contract, когда это необходимо. Большая миграция не удерживает неподконтрольную блокировку всех mutations.

Проверка: принятые до обновления job продолжают выполняться с исходной engine semantics.

### NFR-039. Версионирование контрактов

Коды markers добавляются совместимо: фронт игнорирует неизвестный код при выборе оформления и сохраняет отображение остальных элементов. Бэкенд принимает только свой разрешённый набор. Добавление кода требует совместимого обновления DB CHECK и всех writers до начала записи нового значения. Сохранённые исторические коды не удаляются из допускаемых значений node_revision без миграционной политики; restore не должен терять их молча.

Изменение public API, ошибок, cursors и definition формата имеет документированную совместимость.

Cursor/ссылка со старой версией не интерпретируется молча по новому несовместимому алгоритму. Клиент получает понятный отказ или backward-compatible обработку.

Проверка: контрактные тесты покрывают используемые frontend/sprut-core сценарии.

### NFR-040. Миграция существующего S3-подхода

Перенос bucket/key дерева создаёт стабильные nodes/versions и проверяет inventory/checksums. S3 folder markers преобразуются в metadata папок.

На cutover определяется единственный authoritative writer; старые ProxyS3 mutations не продолжают незаметно менять bytes мимо новой истории/ACL.

Старые rollback по времени, физически удаляющие S3 history, не считаются эквивалентом нового безопасного restore.

Проверка: migration dry run сопоставляет количество/размер/checksums и предоставляет список расхождений; cutover можно выполнить по согласованному runbook.

### NFR-041. Локальная разработка и модульность

Модули namespace/content/bulk/search/retention/access имеют явные интерфейсы. Изменение корректоров не требует произвольных записей в таблицы ACL или GC.

Локальный режим позволяет запускать API и ограниченный worker; production поддерживает раздельные профили. Конфигурация не зависит от ручной подготовки на каждой реплике.

Проверка: интеграционное окружение воспроизводит PostgreSQL/S3/OpenSearch и основные failure scenarios.

### NFR-042. Проверка tenant-конфигурации

Настройка sprut.file-manager.tenant-id обязательна для API и всех worker-профилей. При старте проверяются разрешение переменных окружения, UUID-формат и отсутствие пустого значения. Hot reload tenantId запрещён. Все replicas получают одну конфигурацию развёртывания; API и claim/commit queries ограничены настроенным tenant.

Настроенный UUID сопоставляется с назначением развёртывания в deployment validation и readiness-проверках. Конкретный механизм сверки конфигурации replicas и разрешённых storage spaces задаётся deployment protocol; самостоятельная выдача readiness каждой replica после одной проверки UUID недостаточна для подтверждения общей согласованности. Доступ к общим физическим хранилищам не расширяет tenant scope.

Смена tenantId выполняется по migration runbook с остановкой либо fencing старых writers, проверкой заданий и references и контролируемым переключением. Автоматическое переписывание tenant_id существующих spaces при старте запрещено.

Проверка: missing/unresolved/invalid config приводит к отказу запуска; несовпадение назначения replica и tenant обнаруживается до допуска трафика; изменение конфигурации не открывает чужие данные и не переназначает незавершённые задания.

### NFR-043. Граница доверия gateway и внутренних сервисов

Production соединения gateway/sprut-core → File Manager используют mTLS с проверкой сервисной identity и allowlist caller principals. Настраиваются сетевые ограничения доступа; статус внутреннего сервиса, IP-адрес или наличие X-Actor-* не заменяют аутентификацию caller. Эквивалентный механизм workload authentication допускается только при отдельном утверждении политики безопасности.

Если mTLS завершается на доверенном proxy/sidecar, identity caller передаётся приложению через защищённый канал с исключением прямого обхода proxy и очисткой подменяемых заголовков. Заголовок с именем caller сам по себе не подтверждает workload identity. Ротация сертификатов и отзыв доверия проверяются без обхода fail-closed режима.

Gateway удаляет клиентские X-Actor-* до формирования серверного контекста, включая разные варианты регистра и повторные заголовки. File Manager отклоняет неоднозначные значения и принимает режим USER только от разрешённого делегирующего caller. Caller allowlist, actor mapping и ACL являются разными уровнями проверки.

Production запрещает fallback на неподтверждённые headers, body IDs, anonymous actor или локальный debug principal. Локальный тестовый режим включается явно, недоступен production-профилю и не открывает production-хранилища.

Проверка: отсутствующий/недействительный сертификат, неизвестный caller, прямой обход gateway/proxy, подмена USER, дубли identity headers и отзыв доверия не предоставляют доступ. Разрешённый SERVICE выполняет только операции собственных ACL.

### NFR-044. Согласованность единой YAML-конфигурации

YAML содержит одну общую конфигурацию MinIO и одну OpenSearch. Пропуск обязательных параметров, unresolved credentials и неверный TLS/URI блокируют admission. Raw credentials не хранятся в PostgreSQL и не возвращаются API/HTML/logs.

storage_space хранит выделенный bucket/prefix и fingerprints общих targets, не keys выбора. API/workers сверяют размещение при rollout; mismatch не исправляется автоматическим UPDATE. Credentials не входят в fingerprints. Смена размещения требует migration/rebuild/cutover и fencing.

Конфигурация клиентов меняется контролируемым rollout; hot reload не является baseline. Старый процесс прекращает claim и завершает/ограничивает in-flight I/O перед остановкой. TLS verification и bounded connect/read/write timeouts обязательны. Недоступность OpenSearch обрабатывается как runtime outage с durable backlog, не как повод перезаписывать bindings.

Проверка: stale replica, несовместимый fingerprint и credential rotation не направляют данные в другое хранилище. Отсутствующие настройки не подменяются fallback.

### NFR-045. Роли, внешние назначения и отзыв

Роли ограничены space. Вычисление прав использует актуальные access_role/role_permission/node_acl и доверенные внешние memberships. Permission cache ограничен по актуальности; изменение роли/ACL и commit сериализуются, а invalidation не зависит только от best-effort сообщений. ADMIN не предоставляет неявный READ/WRITE или platform permissions.

Источник и freshness внешних memberships задаются integration protocol, а не постоянной записью user-role в File Manager. Копия roleIds в job не предоставляет бессрочных полномочий. Без актуального подтверждения/в пределах согласованного окна публикация запрещена с безопасным исходом и кодом AUTHORIZATION_CONTEXT_EXPIRED. Точная стратегия refresh/expiry является обязательным открытым интеграционным решением до реализации.

Проверка: cross-space binding, изменение прав используемой роли, архивирование, старый identity snapshot и недоверенный caller не дают лишнего доступа. Права на создание роли, назначение binding и внешнее назначение membership проверяются раздельно.

### NFR-046. MVC и первоначальная настройка

Админка работает через проверенный gateway/caller context и защищённые CSRF-формы. Область MVC: создание/изменение metadata storage_space, роли, состав файловых прав и ACL узлов. Формы подключения, credentials, job control и редактирования retention policies отсутствуют. Общие application services обеспечивают одинаковые проверки REST и MVC.

Общие MinIO/OpenSearch заранее заданы YAML. До первого space создаётся retention policy через защищённый REST. CREATE_SPACE не зависит от ACL ещё не созданного root. Одна TX создаёт space/root/history/ACL/audit/index task/idempotency. Анонимного wizard и автоматического space нет.

Проверка: MVC и REST createSpace возвращают одинаковый результат; UI не принимает endpoint/secret; повтор формы не создаёт второе пространство; конфликт revision сохраняет текущие metadata.

## 11. Обязательная матрица fault/concurrency tests

| Сбой/гонка | Требуемая проверка |
|---|---|
| Crash до/после durable job commit | Нет ложного 202; принятый job восстанавливается |
| Повтор POST после потерянного ответа | Один ресурс для одного key/payload |
| Crash discovery между страницами | Нет потерянного checkpoint и повторных items |
| Crash после upload до publish | Нет доступного неполного результата; объект можно reconcile/GC |
| Timeout commit с неизвестным исходом | Проверка durable состояния до повторной публикации |
| Stale worker после lease reclaim | Поздний heartbeat/commit отклонён |
| Cancel против commit | Нет публикации после cancel boundary |
| ACL revoke против worker commit | Нет новой публикации по отозванному разрешению |
| Два конкурентных rename/move | Unique names, отсутствие циклов, согласованные parent_id/tree_path |
| Падение во время folder prefix rewrite | Полный rollback, нет видимого частичного пути |
| Move сверх maxAtomicMoveFolders | Отказ без изменения дерева и фоново продолжающейся записи |
| COPY/restore/rollback после move | Пути вычислены из текущего parent, не скопированы из истории |
| Markers/markers или markers/rename | Один commit на исходную revision, другой конфликт; нет потерянных назначений |
| Повтор назначения того же набора markers | No-op, без новых S3 объектов и лишней metadata history |
| Save против corrector/rollback | Нет lost update; явный конфликт |
| GC против hold/restore/copy | Не удалены защищённые/shared objects |
| GC delete succeeded, DB update failed | Retry безопасен, metadata eventually очищена |
| OpenSearch delayed writer после delete | Нет воскрешения документа |
| Index task обновилась во время I/O | Новый desiredRevision не потерян |
| Pathological expression | Item ограничен ресурсами; другие workloads продолжаются |
| PostgreSQL failover/restore | Проверены durability, lease invalidation и references |
| Длительный overload | Ограниченная RAM/queue growth; API и fairness измерены |
| Missing/invalid tenant config или несовпадение replicas | Отказ запуска либо допуска трафика; отсутствие доступа вне configured tenant |
| Внешняя подмена actor headers / обход gateway | Нет подмены identity и доступа к данным |
| mTLS failure / отзыв доверия caller | Fail-closed; диагностические headers не дают полномочий |
| SERVICE выдаёт себя за USER | Отказ без разрешённого механизма делегирования |
| Дубликаты/CRLF/превышение длины correlationId | Контролируемый отказ; непроверенное значение не попадает в логи |
| Context propagation при параллельных jobs | Нет смешивания MDC, correlationId и actor-контекста |
| Worker restart и retry после истечения HTTP trace | Durable correlationId сохранён; новый attempt связан с jobId/itemId |
| Tracing backend недоступен или span не sampled | Бизнес-результат не зависит от exporter; durable связь сохранена |

Конкурентные тесты обеспечивают управляемое перекрытие операций и проверяют значения и инварианты; отсутствие исключений не является достаточным критерием.

## 12. Неопределённые параметры

- Production dataset, workload, topology и dependency SLO.
- Численные latency/availability/RPO/RTO targets и методика исключений.
- Retention periods, upload/regex/output budgets, quota и archive limits.
- Максимальное residual access window для presigned URLs.
- Схема сериализации ACL changes с background commits.
- Fair scheduling и атомарная reservation maxParallelItems.
- Семантика глобального времени restore и необходимость multi-file atomic publication.
- Дополнения модели для COPY/ZIP/export и retry failed subset.
- Требования к размещению данных, шифрованию, legal hold и audit от владельцев продукта/безопасности.
- Workload identity, caller allowlist, сервисные actor UUID и механизм делегирования sprut-core.
- Конкретный deployment protocol сверки tenant replicas, migration runbook и управление сертификатами.
- Библиотека tracing, поддерживаемые HTTP/executor/reactive клиенты, sampling и retention telemetry; поддержка X-Correlation-Id проверяется отдельно.
- Реализация durable correlation/tracing и actorType/caller-контекста по обновлённым job/audit таблицам.
- Источник актуальности внешних role memberships и точный refresh/expiry protocol для длительных jobs.
- Согласованный YAML rollout, внешняя ротация credentials и отдельный storage/index cutover protocol.
