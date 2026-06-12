# cs-backend-foundation

Claude Code skill + готовые шаблоны кода: фундамент production-бекенда на **Express + Sequelize (Postgres) + BullMQ (Redis)**, извлечённый из живого платёжного шлюза.

Что внутри:

- **Скилл** (`skills/backend-foundation/SKILL.md`) — учит Claude собирать новый бекенд или расширять существующий по проверенным паттернам.
- **Справочники** (`references/*.md`) — 9 файлов с полным кодом и обоснованиями: контурная архитектура (bounded contexts), ApiError + единый envelope, валидация, JWT-цепочки middleware, гранулярные пермишены + TOTP/2FA, HMAC-подпись публичного API с защитой от replay, рейт-лимитеры, идемпотентные boot-миграции, двойная запись (ledger), BullMQ-воркеры с circuit breaker, graceful shutdown.
- **Шаблоны** (`templates/*.js`) — 17 готовых файлов для копирования в проект.

## Установка

```bash
# в корне проекта:
npm i -D cs-backend-foundation
npx backend-foundation init          # → ./.claude/skills/backend-foundation

# или глобально для всех проектов:
npx backend-foundation init --user   # → ~/.claude/skills/backend-foundation
```

Claude Code подхватит скилл автоматически. Дальше просто просите:

> «Подними новый бекенд по backend-foundation» / «Добавь HMAC API как в backend-foundation» / «Сделай очередь вебхуков по нашему паттерну»

## Состав шаблонов

| Файл | Что даёт |
|---|---|
| `api.error.js` | ApiError со static-фабриками (единственный тип ошибок) |
| `http.helper.js` | envelope `{ok, result, meta}`, asyncHandler, created/paginated, parsePagination |
| `error.middleware.js` | центральный сериализатор ошибок + hook для алертов |
| `validators.js` | `validate` + `vCommon` (express-validator) |
| `logger.helper.js` | JSON/pretty логгер с рекурсивным redact секретов |
| `api.limiter.js` | класс Limiter + makeCounter (login/OTP lockout) |
| `crypto.helper.js` | AES-256-GCM, HMAC canonical-JSON signing, генераторы ключей |
| `auth.middleware.js` | JWT (HS256, jti, revocation), buildPanelMiddleware, TOTP |
| `permissions.helper.js` | каталог пермишенов, hasGranular, requirePermission, пресеты-снапшоты |
| `signature.middleware.js` | HMAC-гейт публичного API + анти-replay (Redis, fail-closed) |
| `queues.connection.js` | BullMQ: makeConnection, defineQueue, queuePrefix, closeQueues |
| `worker.factory.js` | единый фабричный воркер + CircuitBreaker |
| `crons.js` | фабрика кронов (overlap guard) |
| `migrations.runner.js` | двухфазные идемпотентные миграции на буте |
| `env.js` | dotenv-каскад + fail-fast валидация конфига |
| `accounting.core.js` | ledger-ядро: боксы + createTransaction(entries) |
| `tests.setup.js` | guard на `*_test` базу, фикстуры, рецепт конкурентных тестов |

## Лицензия

MIT
