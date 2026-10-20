# Sprut File Manager: технологический стек и структура проекта

Связанные документы:

- [Функциональные требования](../requirements/sprut-file-manager-functional-requirements.md).
- [Нефункциональные требования](../requirements/sprut-file-manager-non-functional-requirements.md).
- [REST-контракт](../contracts/sprut-file-manager-openapi.yaml).
- [Единая YAML-конфигурация и создание spaces](sprut-file-manager-configuration.md).
- [Минимальные файловые алгоритмы](../api/README.md).
- [MVC-контракт](../contracts/sprut-file-manager-mvc-contract.md).
- [Полная модель PostgreSQL](../database/sprut-file-manager-db-all.puml).
- [Дерево parent_id + ltree](sprut-file-manager-tree.md).
- [Схема первоначальной настройки](sprut-file-manager-initial-setup.puml): [PNG](preview/sprut-file-manager-initial-setup.png), [SVG](preview/sprut-file-manager-initial-setup.svg).

## 1. Архитектурное решение

File Manager реализуется как один логический микросервис с функциональными модулями внутри приложения. На начальном этапе используется один Maven-модуль, один Spring Boot entry point и один исполняемый JAR.

Основные принципы:

1. Пакеты группируются по бизнес-возможностям, а не в общие каталоги `controller`, `service`, `repository` для всего приложения.
2. REST, MVC и workers являются разными входными адаптерами общей application-логики.
3. PostgreSQL является источником истины для дерева, прав доступа, версий, space metadata и фоновых заданий.
4. MinIO хранит неизменяемое содержимое. OpenSearch содержит восстанавливаемую поисковую проекцию.
5. Границы Java-модулей не являются границами отдельных БД, сетевых вызовов или независимых транзакций.
6. API и workers могут развёртываться отдельно, оставаясь частями одного сервиса и одной модели данных.
7. Порты и адаптеры вводятся на значимых границах. Отдельный интерфейс для каждого класса и отдельная доменная модель для каждой таблицы не требуются.

Термин «функциональный модуль» далее обозначает группу Java-пакетов. Это не отдельный Maven-модуль, JPMS-модуль или микросервис.

## 2. Технологический стек

### 2.1. Базовый состав

| Область | Технология | Назначение и ограничения |
|---|---|---|
| JVM | Java 25 LTS | Preview-возможности не используются |
| Framework | Spring Boot 4.1.x | Конфигурация приложения, управление совместимыми зависимостями, lifecycle |
| HTTP | Spring MVC и embedded Tomcat | REST, серверный HTML, потоковые ответы; WebFlux не является основным стеком |
| Административный UI | Thymeleaf | Серверный HTML; бизнес-логика в шаблоны не переносится |
| Security | Spring Security | Проверка доверенного caller, pre-authenticated actor context, защита MVC и REST |
| Validation | Jakarta Bean Validation | Структура входных DTO; бизнес-инварианты дополнительно проверяются application/domain |
| Основная БД | PostgreSQL + ltree | Namespace, ACL, история, версии, задания, lease, аудит, идемпотентность |
| SQL-доступ | jOOQ и PostgreSQL JDBC driver | Типизированный SQL, ltree, CAS, очереди и явные блокировки |
| Пул БД | HikariCP | Ограниченные подключения; отдельные бюджеты API и worker-процессов |
| Миграции | Liquibase | Единственный источник изменений физической схемы |
| Объектное хранилище | MinIO Java SDK | S3-compatible операции, multipart, streaming, presigned URL; AWS SDK не используется как основной клиент |
| Поиск | OpenSearch Java client | Индексация, поиск и управление поисковой проекцией |
| Сериализация | Jackson, совместимый с выбранным Spring Boot | REST, NDJSON и типизированные JSON-поля; версия определяется BOM и проверяется с клиентами |
| Фоновые задания | PostgreSQL + Spring scheduling + ограниченные executors | Durable-очереди; scheduling только инициирует обработку |
| Метрики и health | Spring Boot Actuator + Micrometer | API, workers, очереди, зависимости, readiness/liveness |
| Tracing | Micrometer Tracing с OpenTelemetry bridge/export | Инструментирование без дублирования spans |
| Логи | SLF4J + Logback | Структурированные события, редактирование секретов, correlation и tracing |
| Сборка | Maven Wrapper | Воспроизводимая сборка, dependency management, code generation |
| Тесты | JUnit Jupiter, AssertJ, Mockito, Testcontainers | Unit, PostgreSQL-интеграции, SDK-интеграции и конкурентные сценарии |
| Архитектурные проверки | ArchUnit | Проверка пакетов и запрещённых зависимостей; Spring Modulith опционален |
| Упаковка | OCI container image | Один образ приложения с разными ролями запуска |

Базовые версии: Java 25 и Spring Boot 4.1. Согласно официальной документации, Spring Boot 4.1.1 поддерживает Java до 26 включительно; Java 25 входит в этот диапазон. Точные patch-версии закрепляются при создании сборки и проходят интеграционную проверку. [System Requirements](https://docs.spring.io/spring-boot/system-requirements.html)

Версии PostgreSQL, MinIO и OpenSearch выбираются из поддерживаемых инфраструктурой релизов. До реализации фиксируется проверенная матрица server/client/JDK. Тестирование с произвольным контейнером `latest` не заменяет эту матрицу.

### 2.2. Управление зависимостями

- Зависимости Spring согласуются через Spring Boot BOM.
- Для зависимостей вне BOM явно закрепляются версии; для production не используются SNAPSHOT и динамические диапазоны.
- Версии jOOQ runtime и code generator совпадают. При необходимости override обновляет оба компонента и проверяется с Spring Boot.
- Дистрибутив jOOQ выбирается с учётом JDK, редакции и поддерживаемой версии PostgreSQL. Переход на Java 21 требует повторной проверки матрицы; совместимость произвольного актуального jOOQ с Java 21 не предполагается. [jOOQ editions and downloads](https://www.jooq.org/download/)
- Дополнительные HTTP-клиенты и JSON-библиотеки SDK изолируются в адаптерах; конфликты транзитивных зависимостей проверяются сборкой.
- Поставка содержит dependency report, SBOM и результаты проверки уязвимостей.

### 2.3. Компоненты, не входящие в обязательный baseline

| Компонент | Решение |
|---|---|
| Hibernate / JPA | Не используются для основной модели; доступ организован через jOOQ |
| Kafka / RabbitMQ | Не используются для внутренних discovery, correction, indexing и GC очередей |
| Redis | Не требуется для корректности очередей, ACL и блокировок |
| Spring Batch | Не требуется на старте; существующая модель заданий не дублируется второй моделью execution metadata |
| Quartz | Не требуется для надёжности принятых заданий; надёжность обеспечивает PostgreSQL |
| WebFlux / R2DBC | Не вводятся параллельно с MVC/JDBC без отдельного обоснования |
| Spring Cloud | Не является обязательной зависимостью файлового менеджера |
| Native Image | Не входит в начальный вариант |
| Spring Modulith | Допустим для проверки модульных границ; не требуется для выполнения заданий |

Виртуальные потоки могут использоваться после проверки поведения JDBC, SDK и cancellation. Они не отменяют лимиты соединений, параллелизма, памяти и объёма I/O.

## 3. Итоговая структура репозитория сервиса

Базовый Java-пакет: `ru.sprut.filemanager`.

```text
sprut-file-manager/
├── pom.xml
├── mvnw
├── mvnw.cmd
├── .mvn/wrapper/
├── README.md
├── docs/
│   ├── architecture/
│   ├── contracts/
│   ├── requirements/
│   ├── adr/
│   └── runbooks/
├── deploy/
│   ├── local/                         # Локальная инфраструктура и fixtures
│   └── container/                     # Сборка образа и примеры запуска
├── src/
│   ├── main/
│   │   ├── java/ru/sprut/filemanager/
│   │   │   ├── FileManagerApplication.java
│   │   │   ├── configuration/         # Composition root и связывание адаптеров
│   │   │   ├── security/              # Caller authentication и actor context
│   │   │   ├── namespace/             # Пространства и дерево узлов
│   │   │   ├── content/               # Байты, загрузки и версии
│   │   │   ├── access/                # ACL, роли и эффективные разрешения
│   │   │   ├── connections/           # Общие MinIO/OpenSearch клиенты из YAML
│   │   │   ├── correctors/            # Правила и преобразования
│   │   │   ├── operations/            # Длительные операции и их workers
│   │   │   ├── search/                # Поиск и индексация
│   │   │   ├── retention/             # Holds, политики и GC
│   │   │   ├── audit/                 # Аудит изменений и административных действий
│   │   │   └── shared/                # Малые общие типы и технические механизмы
│   │   └── resources/
│   │       ├── application.yaml
│   │       ├── application-local.yaml
│   │       ├── db/changelog/
│   │       │   ├── db.changelog-master.yaml
│   │       │   └── changes/
│   │       ├── templates/admin/
│   │       ├── static/admin/
│   │       └── logback-spring.xml      # Только при необходимости custom-настроек
│   └── test/
│       ├── java/ru/sprut/filemanager/  # Тесты повторяют функциональные пакеты
│       └── resources/
│           ├── fixtures/
│           └── application-test.yaml
└── target/
    └── generated-sources/jooq/         # Не редактируется вручную
```

Документация хранится в `docs/`. REST-контракт хранится в одном файле; копии для публикации генерируются.

`configuration` — место регистрации Spring beans, профилей, transaction manager, клиентов, фильтров и связывания портов. Бизнес-сценарии в этот пакет не помещаются.

## 4. Функциональные модули и владение данными

| Модуль | Ответственность | Основные таблицы |
|---|---|---|
| `namespace` | Spaces, root, дерево, имена, перемещение, маркеры, история metadata | `storage_space`, `fs_node`, `node_revision` |
| `content` | Upload/finalize/abort, attempts, download, версии, физические объекты и готовые ZIP | `file_entry`, `file_version`, `content_object`, `upload_session`, `upload_attempt`, `export_artifact` |
| `access` | Роли, фиксированный каталог прав, ACL, наследование и проверки доступа | `access_role`, `role_permission`, `node_acl` |
| connections | Одна typed YAML-конфигурация MinIO и одна OpenSearch, validation и lifecycle общих SDK-клиентов | Без каталога выбора и DB configuration |
| `correctors` | Шаблоны, immutable-версии правил, компиляция и исполнение преобразований | `corrector_rule_set`, `corrector_rule_version` |
| `operations` | Discovery, элементы заданий, зависимости, прогресс, cancellation, rollback orchestration | `bulk_change_job`, `bulk_change_scope`, `bulk_discovery_cursor`, `bulk_change_item`, `bulk_item_dependency` |
| `search` | Авторизованный поиск, задания индексации, обход поддеревьев, rebuild | `search_index_task`, `search_index_cursor` |
| `retention` | Политики, удержания истории/версий, планирование и выполнение GC | `retention_policy`, `version_hold`, `tree_history_hold`, `gc_task` |
| `audit` | Transactional append и чтение аудита | `audit_event` |
| `shared.idempotency` | Транзакционное сохранение результата повторяемых команд | `idempotency_record` |

Владение таблицей означает владение правилами её изменения. Другой модуль не выполняет произвольный `UPDATE` через чужую реализацию репозитория.

Для чтения допускаются явные SQL-проекции с JOIN между таблицами одной БД, например для listing, ACL или индексации. Это не требует цепочки Java-вызовов на каждый узел. Такая проекция:

- находится в SQL-адаптере читающего модуля;
- возвращает собственную immutable read model;
- ограничена configured tenant, space и правилами доступа;
- не выдаёт наружу jOOQ records или mutable domain objects;
- проверяется интеграционными тестами при миграциях схемы.

Связанные изменения разных владельцев координируются одним application-сценарием и общей транзакцией. Один сценарий не означает один универсальный репозиторий на весь сервис.

Таблицы являются деталями persistence-модели. Отдельный сервис, интерфейс и REST-controller на каждую таблицу не создаются.

## 5. Внутренняя структура модуля

```text
namespace/
├── api/
│   ├── NamespaceCommands.java
│   ├── NamespaceQueries.java
│   └── model/
├── application/
│   ├── CreateNodeUseCase.java
│   ├── MoveNodeUseCase.java
│   ├── ListChildrenQuery.java
│   └── port/
│       ├── NodeRepository.java
│       └── NodeReadRepository.java
├── domain/
│   ├── Node.java
│   ├── NodeName.java
│   ├── NodeType.java
│   └── exception/
└── adapter/
    ├── in/
    │   ├── rest/
    │   │   ├── NodeRestController.java
    │   │   ├── dto/
    │   │   └── mapper/
    │   └── mvc/
    │       ├── SpaceAdminController.java
    │       └── form/
    └── out/
        └── postgres/
            ├── JooqNodeRepository.java
            ├── JooqNodeReadRepository.java
            └── mapper/
```

### 5.1. `api`

Содержит внутрипроцессный контракт для других функциональных модулей: команды, запросы, идентификаторы и результаты. Не является пакетом HTTP-контроллеров.

Контракт не раскрывает `DSLContext`, jOOQ records, `HttpServletRequest`, MVC model, MinIO client и OpenSearch response types.

### 5.2. `application`

Содержит сценарии использования и координацию:

- получение actor/tenant-контекста в явных аргументах;
- проверку актуальных разрешений через `access.api`;
- проверку существования ресурсов и ожидаемой revision;
- управление транзакционными границами;
- вызов доменных правил и persistence-портов;
- запись аудита, истории, идемпотентности и durable tasks;
- перевод ожидаемых конфликтов в типизированные результаты.

Команды изменения и read-only запросы могут иметь отдельные классы без отдельной CQRS-инфраструктуры. Общий command bus не является обязательным.

Application-слой может использовать Spring transactions. Требование независимости от Spring относится прежде всего к чистой доменной модели и алгоритмам.

### 5.3. `domain`

Содержит инварианты, value objects, допустимые переходы состояний и чистые алгоритмы. Не обращается к БД, HTTP, MinIO, OpenSearch и Spring context.

Не требуется дублировать все колонки таблицы в «богатой сущности». Доменные типы выделяются там, где существует бизнес-смысл: имя узла, политика конфликта, состояние операции, правило удержания, параметры преобразования.

### 5.4. `adapter.in`

Входные адаптеры переводят внешний запрос в application-команду:

- REST — HTTP headers/body/query, контрактные DTO и коды ответа;
- MVC — формы, validation errors, CSRF и HTML-представления;
- worker — периодическое пробуждение и передача задания процессору.

Контроллеры не содержат SQL, алгоритмы корректоров и управление физической очисткой объектов.

### 5.5. `adapter.out`

Выходные адаптеры реализуют порты доступа к PostgreSQL, объектам и поиску. Здесь находятся SDK-типы, технические retries, connection acquisition и преобразование внешних ошибок.

Небольшой модуль может иметь сокращённую структуру. Пустые пакеты, `Service`/`ServiceImpl` без необходимости и отдельный mapper для однострочного преобразования не являются требованиями архитектуры.

## 6. Зависимости между модулями

Общие правила:

1. Внешний для модуля Java-код обращается к его `api`, но не к `application`, `domain` и `adapter`.
2. `adapter.in` вызывает application-сценарий; application использует domain и выходные порты; выходной адаптер реализует порт.
3. Модули не вызывают друг друга по HTTP внутри одного процесса.
4. `domain` не импортирует Spring, jOOQ и SDK.
5. `shared` не зависит от функциональных модулей.
6. Циклы между функциональными модулями запрещены.

Базовое направление зависимостей:

- `operations` координирует `namespace`, `content`, `correctors`, `access` и `retention` через их API.
- `namespace` и `content` используют `access`, транзакционный аудит и регистрацию index tasks.
- `search` не вызывает `namespace` и `content` обратно для каждого документа. Для индексации используются собственные read-проекции и выходной порт чтения объектов.
- `retention` не вызывает `operations` для каждого hold. Состояние job и references проверяется SQL-проекциями и условиями той же транзакции; команды управления операцией остаются в `operations`.
- `access` читает структуру наследования своей SQL-проекцией, не вызывая `namespace.api`; это исключает цикл `namespace → access → namespace`.
- connections не зависит от файловых сценариев. Общий YAML определяет клиентов; admission сверяет fingerprints. Выбора конфигурации и CRUD подключений нет.

Регистрация задания индексации — внутритранзакционный метод `search.api`, не HTTP-вызов OpenSearch. Для загрузки документов search-worker использует read-модель из PostgreSQL и технический object-reader, не зависящий от `content.api`.

Общие SDK-механизмы при необходимости размещаются в небольшом техническом адаптере, связываемом через `configuration`. Порт чтения байтов и его реализация не должны создавать обратную зависимость на бизнес-модуль публикации версий. Секреты доступны только доверенным адаптерам подключения, не domain и web DTO.

Точное расположение общих SDK-адаптеров закрепляется при первом вертикальном сценарии. Нельзя устранять цикл переносом всех бизнес-сервисов в `shared` или разрешением взаимных зависимостей.

На старте границы проверяются ArchUnit. Альтернативно Spring Modulith проверяет отсутствие циклов и доступ только к экспортируемым частям модуля. Для приведённой схемы `api` объявляется экспортируемым интерфейсом явно; одно имя пакета не настраивает экспорт автоматически. [Module verification](https://docs.spring.io/spring-modulith/reference/verification.html)

## 7. REST и MVC

Общий context path: `/sprut-file-manager`.

| Вход | Маршруты без context path | Назначение |
|---|---|---|
| REST | `/api/v1/**` | Файловые операции, поиск, jobs, административные команды |
| MVC | `/admin/**` | HTML-интерфейс настройки, ролей, ACL и контроля операций |

`NodeRestController` и соответствующий MVC-controller вызывают один application-сценарий. MVC не делает loopback HTTP-запросы к REST и не пишет напрямую в БД.

В `templates/admin` находятся только представления административных страниц. Полноценный внешний пользовательский файловый frontend не становится частью MVC автоматически.

Ошибки REST соответствуют OpenAPI. Введение другого формата ошибки, дополнительных полей и HTTP-кодов выполняется сначала изменением контракта. MVC использует те же типизированные application-ошибки, преобразуя их в сообщения формы или страницы.

Для потоковых API используются ограниченные буферы, NDJSON для metadata и streaming body для содержимого. Полное дерево или файл не собираются в один `List`/`byte[]`. После начала HTTP-ответа отдельно определяется поведение при обрыве или ошибке; подмена частичного потока успешным полным результатом запрещена.

## 8. Security и контекст запроса

`security` отвечает за транспортное доверие и создание проверенного actor context. `access` отвечает за файловую авторизацию и локальные роли. Это разные обязанности.

Обязательные правила:

- Gateway проверяет внешний пользовательский token, удаляет подставленные клиентом identity headers и формирует доверенные заголовки.
- File Manager аутентифицирует внутреннего caller и проверяет allowlist. Наличие `X-Actor-*` без подтверждённого caller не предоставляет доступ.
- Actor передаётся заголовками `X-Actor-Id`, `X-Actor-Type`; роли и группы — по действующему контракту.
- Tenant не берётся из запроса: один постоянный UUID задаётся конфигурацией развёртывания.
- Роли локальны для space. Назначение role UUID внешним пользователям/сервисам выполняет внешняя identity-система.
- Platform permissions административного интерфейса отделены от файлового права `ADMIN`.
- Проверка прав присутствует в application-сценариях и перед background commit, а не только в контроллере или security filter.
- MVC с browser session использует CSRF-защиту. REST не освобождается от CSRF только из-за формата JSON, если допускает cookie-authentication.

Actor context передаётся в сценарии явно; использование ThreadLocal/MDC не является единственным источником авторизации worker. Для job сохраняется предусмотренный моделью контекст инициатора, но сохранённый список role UUID не становится бессрочным разрешением.

Источник актуальности внешних memberships и refresh/expiry protocol для длительных jobs остаются открытым интеграционным решением. При невозможности подтвердить актуальные полномочия публикация не разрешается.

`X-Correlation-Id` поддерживается отдельно от W3C tracing. Его validation и генерация соответствуют OpenAPI. Для новой worker-попытки создаётся новый span; прежний spanId не используется повторно. Контекст job восстанавливается из durable-данных и очищается после обработки элемента.

## 9. PostgreSQL, jOOQ и транзакции

### 9.1. Схема и генерация

Liquibase задаёт физическую схему; PUML описывает таблицы и связи. jOOQ генерируется по БД, на которую применены миграции.

Последовательность code generation:

1. Создать временный PostgreSQL поддерживаемой версии.
2. Применить Liquibase migrations с нуля.
3. Выполнить jOOQ code generation в `target/generated-sources/jooq`.
4. Подключить generated sources к compile.
5. Выполнить тесты и удалить временную инфраструктуру.

Генерация не подключается к production и не требует прав на изменение рабочей БД. Версии generator/runtime и параметры схемы закрепляются в сборке. Сгенерированные классы вручную не изменяются и в исходный код не копируются.

`DSLContext` участвует в Spring-managed transactions с общим `DataSource`. Репозитории не открывают независимые соединения для записей, которые должны быть атомарны.

### 9.2. Атомарная публикация содержимого

Операция разделяется на внешнее I/O и короткую DB-публикацию:

1. Короткая транзакция резервирует item/lease и необходимые references или holds.
2. Вне транзакции читаются исходные immutable bytes и выполняется преобразование.
3. Вне транзакции новый объект записывается в MinIO по новому физическому ключу. Повтор использует идемпотентный протокол или учитывает созданный orphan.
4. В короткой транзакции проверяются fencing token, отмена, доступ и ожидаемые revisions.
5. В этой же транзакции фиксируются версия, current pointer, история, результат item, аудит, index task и необходимые holds.
6. После commit новый результат считается опубликованным. Неиспользованные объекты обрабатываются безопасным GC-протоколом, а не немедленным бесконтрольным удалением.

Шаги 4–5 координирует один application-сценарий. Обновление `node_revision` при публикации содержимого выполняется через соответствующий namespace-контракт в той же транзакции.

Запрещены `REQUIRES_NEW` для обязательных частей публикации и перенос обязательного аудита/index task в ненадёжное in-memory событие. OpenSearch обновляется после commit по durable task; его недоступность не отменяет уже опубликованную версию.

### 9.3. Конкурентность

- CAS реализуется условием изменения в SQL и проверкой количества изменённых строк, а не одной предварительной проверкой в Java.
- Порядок row locks документируется и одинаков для конкурирующих сценариев.
- Отмена и публикация сериализуются общим протоколом; проверки только перед началом CPU/I/O недостаточно.
- Изменение ACL/ролей и background commit имеют согласованный протокол, исключающий гонку между проверкой и записью. Конкретный протокол остаётся отдельным обязательным решением реализации.
- Время, параметры и seed корректоров фиксируются для воспроизводимого retry.
- Идемпотентный результат сохраняется в той же транзакции, что и эффект команды; предусмотрено поведение при повторе ключа с другим request hash.

### 9.4. Индекс дерева

fs_node.parent_id задаёт связи, nullable tree_path LTREE хранится только у папок. Миграция Liquibase подключает ltree; namespace adapter.out использует типизированный converter/binding jOOQ и параметризованные операторы <@/@>. В HTTP DTO и domain-модели внешнего SDK типов ltree нет.

Текущий subtree/ancestors query не требует Recursive CTE. Для файлов используется JOIN parent, для папок — технический путь UUID. Вычисление logical path и ACL использует текущие имена и grants, не доверяет одному совпадению prefix.

Структурные use cases синхронно поддерживают пути под exclusive space lock. Move папки имеет maxAtomicMoveFolders; prefix rewrite и parent_id фиксируются одной TX. Индексатор OpenSearch не исправляет PostgreSQL tree_path. Исторический manifest и миграционный backfill могут строиться рекурсивно по parent links.

## 10. Фоновые обработчики

### 10.1. Структура `operations`

```text
operations/
├── api/
├── application/
│   ├── StartOperationUseCase.java
│   ├── CancelOperationUseCase.java
│   ├── GetOperationProgressQuery.java
│   ├── RetryOperationUseCase.java
│   ├── RollbackOperationUseCase.java
│   ├── processing/
│   │   ├── DiscoveryProcessor.java
│   │   ├── OperationItemProcessor.java
│   │   └── OperationFinalizer.java
│   └── port/
├── domain/
│   ├── OperationStatus.java
│   ├── CancellationMode.java
│   └── ConflictPolicy.java
└── adapter/
    ├── in/rest/
    ├── in/mvc/
    ├── in/worker/
    └── out/postgres/
```

Все виды задач не объединяются в один универсальный worker. В `search` и `retention` находятся собственные processors, использующие их durable tables.

### 10.2. Протокол выполнения

1. Claim небольшой пачки через `FOR UPDATE SKIP LOCKED` или эквивалентный проверенный протокол.
2. Commit claim с lease и fencing token.
3. Выполнение ограниченной работы вне DB-транзакции.
4. Heartbeat по необходимости; потерявшая lease попытка не имеет права публиковать результат.
5. Короткий commit результата либо запись retry/failure.
6. Reconciliation возвращает потерянную работу в обработку по установленным правилам.

Модель доставки — at-least-once. Повторное исполнение допускается, повторная публикация одного результата предотвращается CAS, fencing, uniqueness и идемпотентностью.

Spring scheduling и локальный executor не являются хранилищем работы. `@Async` не заменяет durable job. `LISTEN/NOTIFY` может ускорять пробуждение, но polling/reconciliation остаются обязательными.

### 10.3. Ограничение ресурсов и отмена

- Ограничиваются размеры claim batches, очередей executor, число одновременных I/O и объём временных файлов.
- Discovery использует checkpoints и bounded batches, не загружая весь список путей в память.
- Пересекающиеся roots не приводят к глобальной блокировке дерева; конфликты конкретных элементов фиксируются отдельно.
- `STOP` прекращает новые публикации и сохраняет уже опубликованное.
- `STOP_AND_ROLLBACK` требует durable-намерения и отдельного компенсирующего выполнения; не является откатом одной SQL-транзакции на всё дерево.
- Прогресс строится по durable counters/items. До завершения discovery итоговое количество элементов может быть неизвестно; оценка не представляется как точный процент.
- Завершение job вычисляется с учётом окончания discovery, зависимостей и terminal states элементов, а не опустевшей локальной очереди.

Пределы CPU/памяти для пользовательских выражений обязательны. Запуск произвольного Java/SpEL/Groovy-кода не допускается. `Future.cancel()` и thread interruption не гарантируют остановку произвольного regex. Движок с ограниченной сложностью либо изолированный процесс выбирается отдельно с учётом требуемого синтаксиса и hard limits.

## 11. Интеграции и управление конфигурацией

### 11.1. Внешняя конфигурация запуска

YAML/env/secret delivery содержат:

- PostgreSQL connection и pool budgets;
- обязательный `sprut.file-manager.tenant-id`;
- context path `/sprut-file-manager`;
- роль запуска и параметры executors/polling;
- caller authentication, trust и allowlist;
- начальные platform grants;
- параметры внешней доставки credentials/ENV placeholders;
- сетевые/secret allowlists, observability и service-level audit retention.

Tenant одинаков у всех replicas; автоматическая генерация при старте и hot reload запрещены. Рабочие значения секретов в Git не сохраняются.

### 11.2. Единая YAML-конфигурация и создание space

MinIO/OpenSearch определяются только YAML; пример находится в [application-file-manager.example.yaml](application-file-manager.example.yaml). Credentials разрешаются внешней доставкой секретов, не вводятся через UI и не сохраняются в PostgreSQL. CRUD подключений и master-key для DB ciphertext отсутствуют.

Администратор создаёт storage_space через MVC/REST, задавая name, retentionPolicyId и initialAccess. Все spaces используют общие MinIO/OpenSearch из YAML, общий bucket с уникальным prefix и общий index alias с tenantId/spaceId. БД сохраняет размещение/fingerprints, не выбор подключения. Смена target требует migration/cutover.

MVC ограничен spaces, ролями и ACL. Retention policy до первого space provisioned через защищённый REST; её выбор доступен форме space. Нулевое число spaces допустимо; root создаётся только после ручной команды. YAML сам по себе не создаёт bucket/index и не предоставляет анонимный доступ администратора.

### 11.3. I/O и проекции

MinIO используется через официальный Java SDK; ошибки, retries и multipart находятся в выходном адаптере. Логический путь узла не используется как mutable physical object key. [MinIO Java SDK](https://github.com/minio/minio-java)

OpenSearch используется через официальный Java client. Поисковый документ содержит необходимые IDs и revision; устаревшая задача не должна перезаписывать более актуальную проекцию. Результаты, snippets и доступ проверяются с учётом authoritative ACL, а не только индекса. [OpenSearch Java client](https://docs.opensearch.org/latest/clients/java/)

Retry классифицирует технические и бизнес-ошибки, использует ограниченные попытки/backoff/jitter и durable scheduling. Тайм-аут внешнего I/O не является доказательством отсутствия побочного эффекта.

## 12. Профили запуска и эксплуатация

Режимы запуска:

| Роль | Активные части | Назначение |
|---|---|---|
| `api` | REST, MVC, application services | Пользовательский и административный трафик |
| `worker` | Discovery, bulk processing, indexing, GC | Фоновая работа без пользовательских контроллеров |
| `all` | API и workers | Локальная разработка и небольшое окружение |

Роли взаимоисключающие; startup validation отклоняет ошибочную комбинацию. `local` обозначает окружение и может сочетаться с ролью. При необходимости worker делится на `bulk` и `maintenance`, но это не создаёт нового владельца БД.

Для worker с web application type `none` MVC/REST и HTTP Actuator не запускаются; health предоставляется механизмом платформы. Если необходим HTTP management endpoint, запускается отдельный защищённый management listener без регистрации пользовательских контроллеров. Конкретный вариант фиксируется deployment-конфигурацией.

API и workers имеют отдельные replica/resource/pool budgets. Суммарное число соединений всех replicas согласуется с PostgreSQL. Неиспользуемый processor не активируется в `api` случайно из-за component scanning.

Миграции production выполняются отдельным контролируемым deployment step с выделенными правами. Runtime-роли не требуют DDL-доступа. Старые и новые replicas совместимы с expand/contract миграциями.

При graceful shutdown прекращается приём новой работы; опубликованные данные сохраняются, незавершённые попытки завершаются в пределах budget либо восстанавливаются по lease. Убийство процесса не теряет принятый job.

Liveness отражает работоспособность процесса. Недоступность OpenSearch не должна провоцировать бесконечные перезапуски всего приложения; состояние отдельных возможностей отражается health/readiness и backlog-метриками. Отсутствие spaces само по себе не делает процесс неисправным.

## 13. Тестовая стратегия

| Уровень | Проверяемые свойства |
|---|---|
| Domain unit | Имена, переходы состояний, политики конфликтов, детерминированность преобразований |
| Application unit | Последовательность сценария и типизированные ошибки с заменой внешних портов |
| PostgreSQL integration | Реальные constraints, CAS, JOIN/CTE, locks, claim, leases, holds и идемпотентность |
| MVC/REST contract | DTO, headers, error codes, CSRF, доверие caller, формы и маршруты |
| SDK integration | Upload/finalize/abort, Range, внешние ошибки, индексация и retries |
| Concurrency regression | Отмена против commit, два writers, revoked ACL, устаревший worker и GC races |
| Architecture | Отсутствие циклов, запрет чужих internals, отсутствие SDK/jOOQ в domain и web DTO |
| Recovery | Падение после upload, до/после commit, потеря lease, восстановление очереди |
| Performance | Большое дерево, bounded memory, fair scheduling, длительная очередь и частичные ошибки |

Для SQL-тестов используется PostgreSQL Testcontainers, не H2: особенности PostgreSQL нельзя подтвердить эмуляцией. Основные concurrency-тесты используют независимые connections/transactions, barriers/latches, bounded waits и передачу ошибок worker в тестовый поток; случайных `sleep` недостаточно.

Обязательные regression-сценарии:

1. Две операции читают одну revision; только одна публикует новую версию, вторая получает определённый конфликт.
2. Отмена фиксируется раньше publication commit; попытка не публикует результат после точки отмены.
3. Worker теряет lease и продолжает I/O; поздний commit отклоняется fencing token.
4. Процесс падает после создания объекта в MinIO; объект либо корректно используется повтором, либо безопасно удаляется позже.
5. PostgreSQL commit успешен, OpenSearch недоступен; содержимое доступно, index task сохраняется и восстанавливается.
6. GC конкурирует с новым hold/reference; используемые байты не удаляются.
7. Роль архивируется или ACL отзывается во время задания; дальнейшая публикация подчиняется протоколу актуальной авторизации.
8. Повтор Idempotency-Key возвращает прежний результат; другой payload с тем же ключом отклоняется.
9. Retry корректора не изменяет ранее зафиксированные дату, seed и параметры.
10. Недоверенный caller с корректными на вид `X-Actor-*` не получает доступ.

## 14. CI и критерии готовности сборки

Минимальная последовательность pipeline:

1. Проверка оформления, OpenAPI и архитектурных документов.
2. Подъём временного PostgreSQL и применение Liquibase.
3. Генерация jOOQ и компиляция.
4. Unit и architecture tests.
5. PostgreSQL/SDK/HTTP integration tests.
6. Проверка миграций с поддерживаемой предыдущей схемы, а не только на пустой БД.
7. Проверка уязвимостей, лицензий и сборка SBOM.
8. Сборка JAR и OCI image.
9. Smoke test ролей `api`, `worker` и сценария первого space.

Конкретные Maven executions и plugin versions задаются в `pom.xml` при реализации. Генерация классов должна завершаться до компиляции, интеграционные тесты — выполняться в CI явно, а не только локально.

## 15. Наблюдаемость

Логи HTTP и worker включают, где применимо: tenantId, caller, actorId/actorType, correlationId, traceId/spanId, jobId/itemId, attempt и leaseToken. Высококардинальные IDs не используются как неограниченные labels метрик.

Обязательные группы метрик:

- latency/error rate REST и MVC;
- DB pool saturation, query/transaction duration и lock contention;
- очередь jobs/items, возраст старейшей задачи, скорость discovery и processing;
- конфликты, retries, lease expiration и длительность cancellation;
- backlog и lag индексации;
- GC backlog, освобождённый объём, holds и restore watermark;
- latency/errors MinIO и OpenSearch;
- использование временного диска, памяти и executor queues.

Трассировка, operational logs и transactional audit выполняют разные функции. Отсутствие tracing backend не отменяет запись обязательного аудита в PostgreSQL. Секреты и содержимое файлов не попадают в telemetry по умолчанию.

## 16. Ограничения текущего проекта и открытые решения

Перед реализацией соответствующих сценариев требуется завершить:

- точные dependency/server versions и проверку корпоративной поддержки Java 25/Spring Boot 4.1;
- протокол актуальности внешних role memberships для длительных jobs;
- реализацию и concurrency-проверку space row-lock барьера и authorization_revision;
- реализацию upload_attempt с отдельными object keys, receipt, lease и fencing;
- реализацию COPY/DELETE/EXPORT по обновлённой модели и завершение неописанных REST-расширений;
- реализацию durable STOP_AND_ROLLBACK, retry lineage и безопасной компенсации;
- Liquibase constraints для rule-set revision, VERSION_RESTORE, попыток и export references;
- движок выражений, поддерживаемый regex-синтаксис и hard resource limits;
- согласование клиента по revision на replicas и storage/index cutover;
- fair scheduling, quotas, retention periods и численные SLO;
- эксплуатационный вариант health worker и управления ключами шифрования.

Эти пункты не считаются реализованными или окончательно определёнными наличием пакета, метода в примере либо маршрута в MVC-контракте.

## 17. Правила дальнейшего развития структуры

Отдельный Maven-модуль вводится только при наличии практической причины: независимая поставка библиотеки, различающийся dependency graph, заметная необходимость compile-time изоляции или отдельный lifecycle сборки.

Выделение нового микросервиса требует самостоятельной ответственности, владения данными и приемлемой модели распределённой согласованности. Размер Java-пакета, число таблиц и количество worker-процессов сами по себе не являются основанием.

Приоритет начальной реализации — вертикальные сценарии: создание первого space, создание узла, upload/finalize/download, затем один durable-корректор с CAS/отменой/аудитом/индексацией. Границы проверяются на этих сценариях до массового создания однотипных классов.
