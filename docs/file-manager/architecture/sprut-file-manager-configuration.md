# Sprut File Manager: единая конфигурация инфраструктуры

## Источники данных

- YAML: один раздел sprut.file-manager.s3 и один sprut.file-manager.opensearch для всех storage_space.
- PostgreSQL: пространства, дерево, ACL, версии, jobs и выделенное физическое размещение.
- MVC: создание пространств, управление ролями и ACL. Настроек подключений и выбора конфигурации нет.

[Пример YAML](application-file-manager.example.yaml) содержит ENV placeholders, не рабочие secrets. Timeout/limits требуют проверки.

## Общие подключения

MinIO: endpoint, region, bucket, base-prefix, credentials, TLS и client timeouts. OpenSearch: endpoints одного кластера, общий index-alias, credentials, TLS и timeouts. Альтернативных подключений нет. Bucket и index/alias подготавливаются инфраструктурой, не админкой.

Все пространства используют общий bucket. Сервер назначает prefix base-prefix/spaces/spaceId/. В общем индексе документы содержат tenantId и spaceId; запросы всегда ограничиваются ими и текущими ACL. Переход между пространствами не меняет SDK client.

Credentials доставляются извне. REST/MVC не принимают endpoints, bucket, index, prefix, TLS или secrets. API каталога конфигураций отсутствует.

## Создание storage_space

1. Первичный администратор получает VIEW_SETUP и CREATE_SPACE из доверенной серверной policy.
2. Retention policy предварительно создаётся защищённым REST API; MVC её только выбирает.
3. Команда принимает name, retentionPolicyId и initialAccess, без выбора инфраструктуры.
4. Сервер использует общую загруженную конфигурацию, выполняет bounded dependency checks вне TX и выделяет spaceId/prefix.
5. Одна TX создаёт space, root/history/initial ACL/audit/index task/idempotency.

## Защита от смены размещения

bucket_name/key_prefix в storage_space — описание выделенной области, не редактируемые настройки. storage_binding_fingerprint и search_binding_fingerprint фиксируют каноническую идентичность общих targets. Keys или ссылки для выбора конфигурации не хранятся.

Storage fingerprint вычисляется по endpoint/region/bucket/base-prefix, search fingerprint — по endpoints/index alias. Credentials, secret references, timeouts и pool sizes исключены. Fingerprints одинаковы у пространств с общим размещением; key_prefix уникален. Это защитная проверка, не отдельные подключения.

При запуске API/workers сверяют YAML с сохранённым размещением. Несовпадение блокирует admission, не исправляется автоматическим UPDATE. Смена DNS/backend под прежним адресом дополнительно проверяется deployment-процедурой.

## Запуск и изменения YAML

- Обязательные поля, URI/TLS и разрешение secrets проверяются до admission. Все replicas получают одну конфигурацию.
- Ноль spaces допустим. YAML не создаёт первое пространство.
- Hot reload не входит в baseline. Изменения применяются согласованным rollout с завершением старого I/O.
- Ротация credentials не меняет размещение. Изменение endpoint/bucket/base-prefix или search target требует проверки совместимости и при смене размещения migration/rebuild/cutover с fencing старых writers.
- Миграция учитывает версии, upload attempts, artifacts, holds и GC tasks, не только текущие файлы.
- Transient OpenSearch outage допускает metadata/bytes с durable indexing backlog.
- Отсутствующие или несовместимые настройки не подменяются fallback.

## Ограничение перемещений

sprut.file-manager.limits.max-atomic-move-folders ограничивает число FOLDER, чьи tree_path меняются одной транзакцией. Учитываются source и вложенные TRASHED/PURGING папки. Эффективное значение возвращается как capabilities.maxAtomicMoveFolders. Превышение даёт 413 RESOURCE_LIMIT_EXCEEDED без изменения parent_id или путей. Значение выбирается нагрузочными тестами; размер хранимого дерева этим лимитом не ограничивается.

## Проверки

Проверяются unresolved secrets, разные настройки replicas, смена target, secret rotation, уникальность prefixes и обязательная фильтрация поиска по tenant/space. Secrets не попадают в API/HTML/audit/logs.
