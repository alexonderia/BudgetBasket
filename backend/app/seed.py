from __future__ import annotations

from app.repositories.base import Repository
from app.security import hash_password


ADMIN_ID = "00000000-0000-0000-0000-000000000001"
ECONOMIST_ID = "00000000-0000-0000-0000-000000000002"
EMPLOYEE_ID = "00000000-0000-0000-0000-000000000003"
DEPARTMENT_ID = "10000000-0000-0000-0000-000000000001"
MODULE_ALPHA_ID = "10000000-0000-0000-0000-000000000002"
MODULE_BETA_ID = "10000000-0000-0000-0000-000000000003"
DDS_OPER_ID = "20000000-0000-0000-0000-000000000001"
DDS_LICENSE_ID = "20000000-0000-0000-0000-000000000002"
INVEST_DEV_ID = "30000000-0000-0000-0000-000000000010"
INVEST_PLATFORM_ID = "30000000-0000-0000-0000-000000000001"
INVEST_INFRA_ID = "30000000-0000-0000-0000-000000000002"
REQUEST_ID = "40000000-0000-0000-0000-000000000001"


def seed_data(repo: Repository) -> None:
    for collection in ("users", "profiles", "units", "units_responsibles", "requests", "req_items", "dds_catalog", "invests_catalog", "storage_objects", "files", "req_item_files", "req_chats", "chat_messages", "chats_participants", "req_logs"):
        repo.load_all(collection)
    if repo.load_all("users"):
        return

    repo.save_all("users", [
        {"id": ADMIN_ID, "login": "admin", "password": hash_password("admin"), "role": "admin"},
        {"id": ECONOMIST_ID, "login": "economist", "password": hash_password("economist"), "role": "economist"},
        {"id": EMPLOYEE_ID, "login": "employee", "password": hash_password("employee"), "role": "employee"},
    ])
    repo.save_all("profiles", [
        {"user_id": ADMIN_ID, "name": "Анна", "second_name": "Игоревна", "last_name": "Администратор", "phone": "+7 900 000-00-01", "email": "admin@example.local", "max_link": ""},
        {"user_id": ECONOMIST_ID, "name": "Елена", "second_name": "Сергеевна", "last_name": "Экономист", "phone": "+7 900 000-00-02", "email": "economist@example.local", "max_link": ""},
        {"user_id": EMPLOYEE_ID, "name": "Иван", "second_name": "Петрович", "last_name": "Сотрудник", "phone": "+7 900 000-00-03", "email": "employee@example.local", "max_link": ""},
    ])
    repo.save_all("units", [
        {"id": DEPARTMENT_ID, "parent_id": None, "name": "Департамент цифровых продуктов", "is_active": True, "uses_invest_projects": False, "annual_budget": 0},
        {"id": MODULE_ALPHA_ID, "parent_id": DEPARTMENT_ID, "name": "Модуль клиентского кабинета", "is_active": True, "uses_invest_projects": False, "annual_budget": 0},
        {"id": MODULE_BETA_ID, "parent_id": DEPARTMENT_ID, "name": "Модуль аналитики", "is_active": True, "uses_invest_projects": True, "annual_budget": 0},
    ])
    repo.save_all("units_responsibles", [
        {"unit_id": MODULE_ALPHA_ID, "user_id": EMPLOYEE_ID, "is_active": True},
        {"unit_id": MODULE_ALPHA_ID, "user_id": ECONOMIST_ID, "is_active": True},
        {"unit_id": MODULE_BETA_ID, "user_id": ECONOMIST_ID, "is_active": True},
    ])
    repo.save_all("dds_catalog", [
        {"id": DDS_OPER_ID, "parent_id": None, "unit_id": DEPARTMENT_ID, "name": "Операционные расходы", "is_active": True},
        {"id": DDS_LICENSE_ID, "parent_id": DDS_OPER_ID, "unit_id": DEPARTMENT_ID, "name": "Лицензии и подписки", "is_active": True},
    ])
    repo.save_all("invests_catalog", [
        {"id": INVEST_DEV_ID, "parent_id": None, "unit_id": DEPARTMENT_ID, "name": "Развитие и инфраструктура", "is_active": True},
        {"id": INVEST_PLATFORM_ID, "parent_id": INVEST_DEV_ID, "unit_id": DEPARTMENT_ID, "name": "Развитие платформы", "is_active": True},
        {"id": INVEST_INFRA_ID, "parent_id": INVEST_DEV_ID, "unit_id": DEPARTMENT_ID, "name": "Инфраструктура", "is_active": True},
    ])
    repo.save_all("requests", [{"id": REQUEST_ID, "economist_id": ECONOMIST_ID, "unit_id": MODULE_ALPHA_ID, "sum_plan": 120000, "sum_fact": 0, "status": "on_review", "frozen": False}])
    repo.save_all("req_items", [
        {"id": "80000000-0000-0000-0000-000000000001", "request_id": REQUEST_ID, "dds_id": DDS_LICENSE_ID, "invest_id": None, "name": "Продление лицензий", "sum_plan": 120000, "sum_fact": 0, "justification": "Поддержка рабочих сервисов", "status": "on_review", "comment": ""},
        {"id": "90000000-0000-0000-0000-000000000001", "request_id": REQUEST_ID, "dds_id": None, "invest_id": INVEST_PLATFORM_ID, "name": "Развитие платформы", "sum_plan": 350000, "sum_fact": 0, "justification": "Историческая строка до v1-17", "status": "deleted", "comment": "Archived during v1-17 migration: unit uses DDS lines."},
    ])
