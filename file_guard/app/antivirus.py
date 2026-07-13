from __future__ import annotations

import logging
import socket
import struct
from dataclasses import dataclass
from collections.abc import Iterator

from .config import settings

logger = logging.getLogger(__name__)
_READINESS_PROBE_BYTES = b"file-guard-health-check"


class AntivirusUnavailableError(RuntimeError):
    """Raised when the antivirus engine cannot be reached or used safely."""


@dataclass(frozen=True, slots=True)
class AntivirusScanResult:
    infected: bool
    signature: str | None = None


class DisabledAntivirusScanner:
    def is_ready(self) -> bool:
        logger.info("Антивирусная проверка отключена настройкой FILE_GUARD_ANTIVIRUS_ENABLED=false")
        return True

    def probe_readiness(self) -> bool:
        return self.is_ready()

    def scan_bytes(self, *, content_bytes: bytes) -> AntivirusScanResult:
        _ = content_bytes
        logger.info("Антивирусная проверка пропущена: встроенный антивирус отключен")
        return AntivirusScanResult(infected=False)


class ClamAVScanner:
    def __init__(
        self,
        *,
        socket_path: str | None = None,
        timeout_seconds: float | None = None,
        stream_chunk_bytes: int | None = None,
    ) -> None:
        self._socket_path = socket_path or settings.clamd_socket_path
        self._timeout_seconds = timeout_seconds or settings.antivirus_timeout_seconds
        self._stream_chunk_bytes = stream_chunk_bytes or settings.clamd_stream_chunk_bytes

    def is_ready(self) -> bool:
        logger.info(
            "Проверяем готовность ClamAV: socket_path=%s timeout_seconds=%s",
            self._socket_path,
            self._timeout_seconds,
        )
        try:
            response = self._send_command(command=b"nPING\n")
        except AntivirusUnavailableError:
            logger.warning("ClamAV недоступен при проверке готовности")
            return False
        logger.info("ClamAV ответил на проверку готовности: response=%s", response)
        return response == "PONG"

    def probe_readiness(self) -> bool:
        if not self.is_ready():
            return False

        logger.info("Проверяем готовность ClamAV пробной чистой проверкой файла")
        try:
            result = self.scan_bytes(content_bytes=_READINESS_PROBE_BYTES)
        except AntivirusUnavailableError:
            logger.warning("ClamAV недоступен при пробной проверке readiness")
            return False

        if result.infected:
            logger.error(
                "ClamAV пометил readiness-пробу как зараженную: signature=%s",
                result.signature or "unknown",
            )
            return False

        logger.info("ClamAV успешно прошел readiness-пробу с реальным INSTREAM-сканированием")
        return True

    def scan_bytes(self, *, content_bytes: bytes) -> AntivirusScanResult:
        logger.info(
            "Запускаем антивирусную проверку файла: size_bytes=%s chunk_size=%s",
            len(content_bytes),
            self._stream_chunk_bytes,
        )
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(self._timeout_seconds)
                client.connect(self._socket_path)
                client.sendall(b"nINSTREAM\n")
                for chunk in _iter_chunks(content_bytes, self._stream_chunk_bytes):
                    client.sendall(struct.pack(">I", len(chunk)))
                    client.sendall(chunk)
                client.sendall(struct.pack(">I", 0))
                response = self._read_line(client)
        except (OSError, TimeoutError, ValueError) as exc:
            logger.exception("Ошибка при потоковой проверке файла в ClamAV")
            raise AntivirusUnavailableError("ClamAV stream scan failed") from exc

        if response.endswith(" OK"):
            logger.info("Антивирусная проверка завершена успешно: угроз не найдено")
            return AntivirusScanResult(infected=False)
        if response.endswith(" FOUND"):
            signature = response.split(": ", 1)[1].rsplit(" FOUND", 1)[0].strip()
            logger.warning("Антивирус обнаружил угрозу: signature=%s", signature or "unknown")
            return AntivirusScanResult(infected=True, signature=signature or None)
        if "ERROR" in response:
            logger.error("ClamAV вернул ошибку при проверке файла: response=%s", response)
            raise AntivirusUnavailableError(response)
        logger.error("ClamAV вернул неожиданный ответ: response=%s", response)
        raise AntivirusUnavailableError(f"Unexpected ClamAV response: {response}")

    def _send_command(self, *, command: bytes) -> str:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(self._timeout_seconds)
                client.connect(self._socket_path)
                client.sendall(command)
                return self._read_line(client)
        except (OSError, TimeoutError, ValueError) as exc:
            logger.exception("Ошибка при выполнении служебной команды ClamAV")
            raise AntivirusUnavailableError("ClamAV command failed") from exc

    @staticmethod
    def _read_line(client: socket.socket) -> str:
        chunks: list[bytes] = []
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        if not chunks:
            raise ValueError("Empty ClamAV response")
        return b"".join(chunks).decode("utf-8", errors="replace").strip()


def _iter_chunks(content_bytes: bytes, chunk_size: int) -> Iterator[bytes]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    for index in range(0, len(content_bytes), chunk_size):
        yield content_bytes[index : index + chunk_size]
