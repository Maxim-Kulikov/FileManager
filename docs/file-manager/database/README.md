# Sprut File Manager: модель PostgreSQL

## Представления

| Файл | Содержание |
|---|---|
| [Обзор](sprut-file-manager-db.puml) | Владение данными и взаимодействие подсистем |
| [Полная схема](sprut-file-manager-db-all.puml) | Все 27 таблиц, константы, комментарии и межраздельные связи |
| [Namespace](sprut-file-manager-db-namespace.puml) | Пространства, дерево, ACL и история |
| [Content](sprut-file-manager-db-content.puml) | Версии, объекты, upload session/attempt и export artifact |
| [Bulk](sprut-file-manager-db-bulk.puml) | Правила, задания, discovery, manifest и зависимости |
| [Retention](sprut-file-manager-db-retention.puml) | Политики, holds и безопасная физическая очистка |
| [Search/audit](sprut-file-manager-db-search-audit.puml) | Индексация, аудит и идемпотентность |
| [Administration](sprut-file-manager-db-administration.puml) | Роли, права и их bindings |

Каждый PUML самодостаточен и не требует include с внешнего сервера. Одноимённые SVG восьми представлений находятся в [preview](preview/). Полная диаграмма не масштабируется до ширины страницы: детальные схемы предназначены для чтения отдельных разделов.

## Изменения модели

- `upload_attempt` отделён от `upload_session`. Session содержит intent, текущую попытку и опубликованный результат; attempt — отдельный object key, multipart ID, lease/token и durable progress.
- `export_artifact` содержит готовящийся ZIP, текущий build object, TTL, fencing и bounded read pin. Manifest хранится в `bulk_change_item` с операцией `EXPORT_ENTRY`.
- `bulk_change_job` поддерживает COPY/DELETE/EXPORT/VERSION_RETIREMENT, cancel mode, автоматическую компенсацию и отдельную retry lineage.
- `bulk_change_item` содержит source/target copy fields, before-state, результат CAS содержимого, путь ZIP entry и ссылку на повторяемый item.
- `corrector_rule_set.revision` используется для metadata CAS; version number правил остаётся отдельным понятием.
- `file_version.origin` включает VERSION_RESTORE.
- storage_space сохраняется. MinIO/OpenSearch имеют по одной общей конфигурации из YAML. Пространство хранит immutable bucket/prefix и защитные fingerprints, без keys выбора, endpoints и credentials.
- `storage_space.authorization_revision` используется совместно с row-lock барьером локальной авторизации; не заменяет проверку ACL и актуальной внешней identity.
- `version_hold` поддерживает EXPORT. GC учитывает file versions, upload attempts, artifacts и read pins.

Отдельные таблицы effective permissions, пользовательских memberships, markers, breadcrumbs и каталога движков не добавляются.

## Дерево папок

fs_node использует parent_id и производный tree_path типа ltree. Путь хранится только у FOLDER, FILE имеет NULL. Он состоит из UUID-меток, не имён; GiST используется для принадлежности поддереву. REST-поле path остаётся отображаемым путём.

Создание, move, COPY и restore синхронно поддерживают пути в той же TX, что и структуру. Move папки обновляет пути всех вложенных папок, включая TRASHED/PURGING, и ограничен maxAtomicMoveFolders. Асинхронное обновление текущего tree_path запрещено. История хранит parent_node_id, не копию технического пути.

[Правила дерева, индексы, миграция и проверки](../architecture/sprut-file-manager-tree.md).

## Соглашения

Несколько колонок с `<<PK>>` означают один составной первичный ключ. `<<ref>>` обозначает ссылку на таблицу, подробно описанную в другом представлении. Раздел «Допустимые значения» содержит константы доменов, а не дополнительные колонки.

`node_id` у COPY_NODE — заранее выделенный ID назначения. Повтор discovery находит тот же item и не создаёт новый ID. Для EXPORT_ENTRY `node_id` обозначает исходный файл, а `target_version_id` — зафиксированную manifest-версию.

`source_version_id` COPY — версия источника; `base_version_id` COPY_CONTENT — старая версия назначения. `resultNodeId` новой копии вычисляется из `node_id` успешного item. Новая копия и замена содержимого существующего файла не являются одной операцией.

`source_job_id/source_item_id` — компенсация. `retry_of_job_id/retry_of_item_id` — новый subset-запуск. `rollback_job_id` — единственная автоматическая компенсация принятого STOP_AND_ROLLBACK, а не список всех ручных rollback.

Структурный rollback использует before-state и CAS опубликованного состояния. Для созданной папки нельзя удалить чужие новые children. Зависимости компенсации направлены от родителя к уже завершённой компенсации его children; конфликт child защищает родителя от удаления.

## Обязательные инварианты реализации

1. Локальная проверка доступа и публикация используют shared lock строки space и свежий READ COMMITTED snapshot. Изменение ACL/ролей или структуры, влияющей на доступ, использует exclusive lock и увеличивает authorization_revision в той же транзакции. Несколько spaces блокируются в порядке UUID.
2. Cancel и publication сериализуются блокировкой job. После commit отмены новые изменения не публикуются. STOP_AND_ROLLBACK сохраняет intent и holds независимо от admission компенсации.
3. Новый upload attempt и новая попытка ZIP build всегда имеют новый физический object key. Lease не отменяет S3 I/O; устаревший writer отсекается при commit, а его результат становится кандидатом reconciliation/GC.
4. Finalize upload проверяет current attempt и VERIFIED receipt; новая версия, pointer, история, аудит и index task фиксируются атомарно. COMPLETED replay не публикует старую версию повторно.
5. ZIP выдаётся только после READY. Полнота manifest и успешные EXPORT_ENTRY сами по себе не означают готовность архива.
6. Большой manifest проверяется по страницам при стабильной authorization_revision; финальный admission сверяет её под shared lock и фиксирует artifact read pin в короткой транзакции. Смена поколения требует повтора либо отказа. Миллион ACL/holds не обновляется одной транзакцией.
7. Активный bounded download защищается read_protected_until. Поток завершается до истечения защиты либо своевременно продлевает её; crash reader не создаёт бессрочный pin.
8. GC проверяет все живые references под object row lock. READY/VERIFIED и создание новых references запрещены после GC_PENDING. Expired artifact с read pin ещё защищает объект и manifest.
9. COPY source/base/result и restore target удерживаются на нужный период. Автоматическая компенсация не теряет holds между фазами. EXPORT holds освобождаются пакетами после expiry и окончания read pin.
10. Physical delete/abort использует точный target snapshot. Для повторных ZIP builds abort target ID связан с отдельным build object, а не с постоянным artifact ID. Сбой между provider operation и записью receipt требует scoped reconciliation.

В комментариях PUML перечислены CHECK/FK/UNIQUE, индексы и протоколы. Простые ограничения одной строки реализуются SQL CHECK, связи — FK, уникальность — UNIQUE/partial indexes. Межтабличные условия, DAG, state transitions и проверки lease/permission не выражаются обычным CHECK с чтением других таблиц: необходимы составные FK, транзакционные application-сценарии и при необходимости triggers.

## Синхронизация и проверки

Источники таблиц — шесть детальных схем. Полная схема генерируется и вручную не редактируется:

```powershell
node file-manager/tools/sync-db-diagrams.cjs
node file-manager/tools/sync-db-diagrams.cjs --check
```

Статическая проверка сравнивает определения, проверяет комментарии колонок и обязательные поля новых протоколов:

```powershell
node file-manager/tools/validate-file-manager-design.cjs C:/Users/kulik/AppData/Local/Temp/sprut-openapi-validation-20261008
```

Каталог validator dependencies должен содержать `yaml/package` и `tv4/package`. Синтаксис PUML проверяется до рендеринга через PlantUML `-pipe -syntax`; SVG обновляются явно с `-tsvg -nometadata` в папке preview. Изображения рядом с PUML не создаются; набор форматов сохраняется.

## Нерешённые вопросы

`x-db-status=covered` означает наличие необходимых сущностей в модели БД.

Модель предусматривает COPY_CONTENT и VERSION_RETIREMENT, но новый режим замены файла и отдельный bulk version-retirement endpoint ещё не добавлены. Effective-permissions API, engine catalog и согласование доступа к каталогу ролей являются отдельной доработкой контрактов.

Открыты внешний membership refresh/expiry, параметры TTL/quotas/retry budgets, exact SDK/server compatibility и эксплуатационные YAML/deployment процедуры смены подключений. Все перечисленные протоколы требуют реальных transaction/concurrency/recovery tests после реализации.
