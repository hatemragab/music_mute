from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AllowedModel = Literal["UVR-MDX-NET-Inst_HQ_3", "Kim_Vocal_2", "htdemucs"]
AllowedStems = Literal["vocals", "2stems", "4stems"]

MODEL_CHOICES: tuple[str, ...] = ("UVR-MDX-NET-Inst_HQ_3", "Kim_Vocal_2", "htdemucs")
STEM_CHOICES: tuple[str, ...] = ("vocals", "2stems", "4stems")


class SeparateResponse(BaseModel):
    job_id: str
    status: str = "queued"
    source: Literal["upload", "youtube"]
    title: str | None = None


class ResultItem(BaseModel):
    stem: str
    url: str
    size_bytes: int | None = None
    duration_s: float | None = None


class JobResponse(BaseModel):
    job_id: str
    status: Literal["queued", "processing", "done", "failed"]
    progress: int = Field(ge=0, le=100, default=0)
    stage: str = "queued"
    model: str | None = None
    stems: list[str] | None = None
    results: list[ResultItem] = Field(default_factory=list)
    error: str | None = None
    created_at: datetime | None = None
    finished_at: datetime | None = None


class ModelInfo(BaseModel):
    name: str
    display_name: str
    stems_supported: list[str]
    est_speed: str
    est_ram: str
    description: str


MODELS_CATALOG: list[ModelInfo] = [
    ModelInfo(
        name="UVR-MDX-NET-Inst_HQ_3",
        display_name="UVR-MDX-NET Inst HQ 3 (default)",
        stems_supported=["vocals", "instrumental"],
        est_speed="~2-3 min / 4 min song @ 2 vCPU",
        est_ram="~2 GB",
        description="MDX-Net 2-stem (vocals + instrumental). Balanced quality/speed on CPU.",
    ),
    ModelInfo(
        name="Kim_Vocal_2",
        display_name="Kim Vocal 2",
        stems_supported=["vocals"],
        est_speed="~2-3 min / 4 min song @ 2 vCPU",
        est_ram="~2 GB",
        description="MDX-Net vocals-only. Use when you only need the vocal stem.",
    ),
    ModelInfo(
        name="htdemucs",
        display_name="htdemucs (Demucs v4)",
        stems_supported=["vocals", "drums", "bass", "other"],
        est_speed="~5-8 min / 4 min song @ 2 vCPU (slow)",
        est_ram="~3 GB",
        description="Demucs v4 4-stem opt-in. Higher quality, noticeably slower on CPU.",
    ),
]


class HealthResponse(BaseModel):
    status: str
    mongo: str
    s3: str
    queue: str
    models_baked: list[str]
