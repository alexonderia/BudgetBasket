# BudgetBasket

BudgetBasket - прототип системы сбора и утверждения бюджетных заявок по модулям/юнитам компании.

## Стек

- Backend: FastAPI, Pydantic, SQLAlchemy 2.x, Alembic
- Database: PostgreSQL
- Object storage: SeaweedFS через S3-compatible API
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

## Проверки

```bash
docker compose ps
docker compose exec postgres pg_isready -U budgetbasket -d budgetbasket
curl http://localhost:8000/health
curl http://localhost:8000/health/db
curl http://localhost:8333
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
```

## Файлы

Пользовательские файлы загружаются напрямую к строкам заявки:

- `POST /dds-items/{itemId}/files`
- `POST /invest-items/{itemId}/files`

Backend сохраняет бинарные данные в SeaweedFS через S3-compatible API, а метаданные - в PostgreSQL. Внутренний `storage_key` клиенту не раскрывается; скачивание идет через:

- `GET /files/{fileId}/download`

## Локальная разработка без Docker

```bash
cd backend
python -m pip install -r requirements.txt
set DATABASE_URL=postgresql://budgetbasket:budgetbasket@localhost:5433/budgetbasket
set S3_ENDPOINT=http://localhost:8333
python -m alembic upgrade head
uvicorn app.main:app --reload
```

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

cd ../frontend
npm test
npm run build
```
