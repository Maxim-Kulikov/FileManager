# Sprut File Manager: MVC-контракт административного интерфейса

## Границы интерфейса

Context path: /sprut-file-manager. Маршруты ниже начинаются /admin. MVC и [REST](sprut-file-manager-openapi.yaml) вызывают общий application layer; loopback HTTP и прямые записи контроллеров в БД запрещены.

MVC управляет storage_space, локальными ролями, составом фиксированных файловых прав и ACL узлов. Экранов подключения S3/OpenSearch, ввода secrets, редактирования retention policies и управления jobs нет. Пользовательский файловый интерфейс использует REST; наличие MVC не переносит весь frontend внутрь сервиса.

MinIO/OpenSearch имеют по одной общей конфигурации из серверного YAML. Формы принимают metadata и права, без выбора подключения. БД хранит размещение/fingerprints, не client configuration.

Browser вход проходит gateway SSO/session. Gateway заменяет клиентские X-Actor-*; File Manager проверяет caller и platform/file permissions. Собственного login/password, анонимного wizard и автоматического первого space нет.

## Формы и ответы

- Content-Type: application/x-www-form-urlencoded. Изменяющий POST содержит CSRF token; cookie-authenticated REST mutations также защищены при их разрешении.
- Create POST содержит idempotencyKey. Update содержит expectedRevision; application выполняет CAS, не доверяет hidden field без проверки.
- Успех: 303 See Other с относительным Location, context path ровно один раз. GET не изменяет состояние.
- Ошибки: 400 структура/headers; 403 доступ/CSRF; 404 недоступный ресурс; 409 конфликт; 412 stale revision; 413 размер body; 422 semantic validation; 428 отсутствующая revision; 503 временный отказ. HTML содержит code/message/correlationId, без stacktrace/secrets.
- Роль содержит только READ/WRITE/DELETE/SHARE/ADMIN. Произвольные permission codes и platform permissions через UI не создаются.
- Роль не назначается пользователю внутри File Manager: membership управляется внешней системой. UI создаёт binding роли на узле.

## GET-страницы

| Путь | Содержание | Доступ |
|---|---|---|
| /admin | Состояние настройки и доступные spaces | VIEW_SETUP либо READ доступного space |
| /admin/spaces | Каталог и форма создания | CREATE_SPACE для создания; scoped READ для просмотра |
| /admin/spaces/{spaceId} | Имя, состояние, политика хранения и права пространства; без выбора подключения | READ; изменение ADMIN корня |
| /admin/spaces/{spaceId}/roles | Роли пространства, создание и статус ACTIVE/ARCHIVED | MANAGE_ROLES либо ADMIN корня |
| /admin/roles/{roleId} | Metadata, revision и состав прав | MANAGE_ROLES либо ADMIN корня |
| /admin/nodes/{nodeId}/access | Прямые bindings узла; информация о наследовании | ADMIN соответствующего узла |

## POST-формы

Пути форм в таблице заданы относительно /admin.

| Путь | Поля сверх CSRF | Общая операция REST | Успешный redirect |
|---|---|---|---|
| /spaces | idempotencyKey, name, retentionPolicyId, initialAccess | createSpace | /admin/spaces/{id} |
| /spaces/{spaceId}/update | expectedRevision, name/status/retentionPolicyId | updateSpace | Страница space |
| /spaces/{spaceId}/roles | idempotencyKey, name, description, permissions | createRole | /admin/roles/{id} |
| /roles/{roleId}/update | expectedRevision, name/description/status=ARCHIVED | updateRole | Страница роли |
| /roles/{roleId}/permissions | expectedRevision, полный permissions | replaceRolePermissions | Страница роли |
| /nodes/{nodeId}/access | idempotencyKey, subjectType, subjectId, inheritanceMode; permissions только для прямого grant | createNodeAcl | Страница доступа |
| /nodes/{nodeId}/access/{aclId}/revoke | идентификаторы узла и grant | revokeNodeAcl | Страница доступа |

ROLE body не содержит permissions; состав читается из role_permission. USER/GROUP/SERVICE grants сохранены. Архивирование роли необратимо; новый доступ после архива требует нового role UUID. ADMIN — файловое право, не platform administrator и не неявный READ/WRITE.

## Первое пространство

1. Deployment задаёт общие MinIO/OpenSearch в YAML и policy первоначального администратора; bucket/index готовятся вне MVC.
2. Контролируемый provisioning создаёт retention policy через защищённый POST /api/v1/retention-policies. В MVC policy выбирается, но не создаётся и не редактируется.
3. Администратор задаёт name, retentionPolicyId и initialAccess. Выбора инфраструктуры нет.
4. До TX проверяется YAML snapshot и доступность требуемой инфраструктуры bounded I/O. В TX: storage_space/root/history/initial ACL/audit/index task/idempotency. Префикс определяется сервером как base/spaces/spaceId/; S3 directory marker не создаётся.
5. Минимум один USER/SERVICE получает READ+ADMIN на SUBTREE. WRITE/DELETE/SHARE предоставляются явно. Создаются роли и их bindings; внешняя система назначает memberships.
6. Проверяются listing/upload/download/search. Неудачная проверка не удаляет созданный space автоматически.

## Дерево

MVC использует общие namespace use cases и не принимает tree_path. Создание папок вычисляет UUID-путь на сервере. Rename сохраняет технический путь; move атомарно обновляет prefix вложенных папок с ограничением maxAtomicMoveFolders. При 413 RESOURCE_LIMIT_EXCEEDED показывается ошибка без изменения дерева. [Правила дерева](../architecture/sprut-file-manager-tree.md).

## Ограничения

Общие подключения не меняются через updateSpace. Смена размещения требует migration/rebuild/cutover и fencing writers. Ноль spaces допустим; secrets/endpoints не попадают в HTML/audit.

Механизм актуальности внешних memberships остаётся обязательным отдельным integration protocol. Local ACL/role изменения сериализуются с публикацией через space lock и authorization_revision.
