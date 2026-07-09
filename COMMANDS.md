# BudgetBasket Commands

## One-time Setup

```bash
docker compose up -d --build
docker compose exec backend alembic current
docker compose exec postgres pg_isready -U budgetbasket -d budgetbasket
Start-Process http://localhost:5050
```

## Initial Database Prep

```bash
docker compose exec backend alembic upgrade head
docker compose exec backend python -m pytest
```

## Daily Run

```bash
docker compose up -d
docker compose ps
docker compose logs -f backend
```

## Daily Backend Work

```bash
docker compose exec backend alembic upgrade head
docker compose exec backend python -m pytest
docker compose exec backend python -m compileall app
```

## Daily Frontend Work

```bash
cd frontend
npm test
npm run build
```

## Useful Checks

```bash
curl http://localhost:8000/health
curl http://localhost:8000/health/db
curl http://localhost:8333
curl http://localhost:5050
```

## Local Dev Without Docker

```bash
cd backend
python -m pip install -r requirements.txt
python -m alembic upgrade head
uvicorn app.main:app --reload
```

```bash
cd frontend
npm install
npm run dev
```
