import hashlib
import hmac
import secrets


HASH_PREFIX = "pbkdf2_sha256"
HASH_ITERATIONS = 390_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), HASH_ITERATIONS)
    return f"{HASH_PREFIX}${HASH_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored_password: str) -> bool:
    if not stored_password.startswith(f"{HASH_PREFIX}$"):
        return hmac.compare_digest(password, stored_password)
    try:
        _, iterations, salt, expected = stored_password.split("$", 3)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


def needs_rehash(stored_password: str) -> bool:
    return not stored_password.startswith(f"{HASH_PREFIX}$")
