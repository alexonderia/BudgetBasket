from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ValidationResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    valid: bool
    detected_mime_type: str = Field(alias="detectedMimeType")
    size_bytes: int = Field(alias="sizeBytes")
    reason_code: str | None = Field(alias="reasonCode")
    message: str | None
    warnings: list[str] = Field(default_factory=list)
