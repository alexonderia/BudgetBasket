# BudgetBasket

BudgetBasket - прототип системы сбора и утверждения бюджетных заявок по модулям/юнитам компании.

## Стек

- Backend: FastAPI, Pydantic, SQLAlchemy 2.x, Alembic
- Database: PostgreSQL
- Object storage: SeaweedFS через S3-compatible API
- Проверка файлов: изолированный FastAPI-сервис `file_guard`, libmagic, структурные парсеры и ClamAV
- Frontend: React, TypeScript, Vite, MUI
- Запуск: Docker Compose

## Локальный запуск

```bash
docker compose up -d --build
```

После запуска:

- Frontend: http://localhost:5173
- Backend API: http://localhost:8000
- Swagger: http://localhost:8000/docs
- SeaweedFS S3 API: http://localhost:8333
- PostgreSQL admin panel: http://localhost:5050
- PostgreSQL с хоста: `localhost:5433`

Backend внутри Docker подключается к PostgreSQL по `postgres:5432` и к SeaweedFS по `http://seaweedfs:8333`.
`file_guard` доступен только backend по `http://file_guard:8080`; его порт не публикуется на хост, контейнер не подключён к сетям PostgreSQL и SeaweedFS.

## Проверки

```bash
docker compose ps
docker compose exec postgres pg_isready -U budgetbasket -d budgetbasket
curl http://localhost:8000/health
curl http://localhost:8000/health/db
curl http://localhost:8333
docker compose exec file_guard curl --fail http://localhost:8080/health
docker compose exec file_guard curl --fail http://localhost:8080/ready
```

## Миграции

Миграции применяются автоматически при старте backend-контейнера:

```bash
alembic upgrade head
```

Проверить текущую ревизию:

```bash
docker compose exec backend alembic current
```

## Тестовые пользователи

- Администратор: `admin` / `admin`
- Экономист: `economist` / `economist`
- Сотрудник: `employee` / `employee`

Пароли в БД хранятся в виде PBKDF2-хэшей.

## Env

Пример находится в `.env.example`.

Ключевые переменные:

```env
DATABASE_URL=postgresql://budgetbasket:budgetbasket@postgres:5432/budgetbasket
S3_ENDPOINT=http://seaweedfs:8333
S3_REGION=us-east-1
S3_ACCESS_KEY=budgetbasket
S3_SECRET_KEY=budgetbasket_secret
S3_BUCKET=budgetbasket-files
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_URL=http://localhost:8333
MAX_UPLOAD_FILE_SIZE_MB=25
FILE_GUARD_URL=http://file_guard:8080
FILE_GUARD_MAX_FILE_SIZE_BYTES=26214400
FILE_GUARD_ALLOWED_EXTENSIONS=.pdf,.png,.jpg,.jpeg,.xlsx,.docx
FILE_GUARD_ANTIVIRUS_ENABLED=true
FILE_GUARD_REQUIRE_ANTIVIRUS=true
```

## Файлы

Пользовательские файлы загружаются напрямую к строкам заявки:

- `POST /dds-items/{itemId}/files`
- `POST /invest-items/{itemId}/files`

Импорт справочников принимает только `.xlsx` через `POST /catalog/{kind}/import`. Все три сценария используют один порядок обработки:

`frontend → backend (авторизация) → file_guard → backend → SeaweedFS/БД или импорт`

До положительного ответа `file_guard` файл не записывается в SeaweedFS, для него не создаются строки в БД и не выполняется импорт. При отклонении backend возвращает `400` с безопасным сообщением на русском языке. При таймауте, недоступности или некорректном ответе сервиса backend возвращает `503` и ничего не сохраняет.

### Проверки file_guard

Текущие правила для вложений строк заявки:

- форматы: PDF, PNG, JPG/JPEG, XLSX и DOCX; импорт НСИ принимает только XLSX;
- размер каждого файла — не более 25 МиБ (`25 × 1024 × 1024` байт); пустые файлы запрещены;
- имя не может содержать управляющие символы, абсолютный путь или `..`;
- расширение, MIME, заявленный клиентом `Content-Type` и сигнатура файла должны совпадать;
- PDF не может быть повреждённым, зашифрованным или содержать JavaScript, автозапуск, вложения и другое активное содержимое;
- DOCX/XLSX проверяются как ZIP-контейнеры: максимум 200 записей, 40 МиБ распакованных данных, 12 МиБ на запись и коэффициент сжатия до 120; запрещены path traversal, макросы, бинарные/скриптовые вложения и опасные внешние связи;
- PNG/JPEG полностью декодируются; лимит изображения — 12 000 × 12 000 пикселей и 40 млн пикселей;
- самостоятельные ZIP/RAR/7z и исполняемые, скриптовые, macro-enabled файлы (`.xlsm`, `.docm`) не разрешены.

Frontend ограничивает выбор теми же расширениями и размером, но окончательное решение всегда принимает `file_guard`.

ClamAV включён в Docker Compose и выполняет реальную локальную антивирусную проверку. При недоступной антивирусной базе `/ready` остаётся неготовым, а проверка закрывается с ошибкой. Отключить ClamAV можно только явной настройкой `FILE_GUARD_ANTIVIRUS_ENABLED=false`; при `FILE_GUARD_REQUIRE_ANTIVIRUS=true` сервис всё равно останется неготовым.

Внутренний контракт:

```http
POST /internal/files/validate
Content-Type: multipart/form-data
```

```json
{
  "valid": true,
  "detectedMimeType": "application/pdf",
  "sizeBytes": 123456,
  "reasonCode": null,
  "message": null,
  "warnings": []
}
```

Лимиты и включаемые проверки задаются переменными `FILE_GUARD_*` из `.env.example`.

Backend сохраняет бинарные данные в SeaweedFS через S3-compatible API, а метаданные - в PostgreSQL. Внутренний `storage_key` клиенту не раскрывается; скачивание идет через:

- `GET /files/{fileId}/download`

## Локальная разработка без Docker

```bash
cd backend
python -m pip install -r requirements.txt
set DATABASE_URL=postgresql://budgetbasket:budgetbasket@localhost:5433/budgetbasket
set S3_ENDPOINT=http://localhost:8333
set FILE_GUARD_URL=http://localhost:8080
python -m alembic upgrade head
uvicorn app.main:app --reload
```

Для такого запуска `file_guard` должен быть отдельно запущен на порту 8080 (например, `uvicorn file_guard.app.main:app --port 8080` из корня репозитория; для локального режима без ClamAV задайте `FILE_GUARD_ANTIVIRUS_ENABLED=false` и `FILE_GUARD_REQUIRE_ANTIVIRUS=false`).

```bash
cd frontend
npm install
npm run dev
```

## Проверки кода

```bash
cd backend
python -m pytest
python -m compileall app

cd ..
python -m pytest file_guard/tests

cd ../frontend
npm test
npm run build
```
