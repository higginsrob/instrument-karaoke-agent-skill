from __future__ import annotations

from fastapi import APIRouter

from server.config import settings
from server.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    cuda = False
    try:
        import torch

        cuda = bool(torch.cuda.is_available())
    except ImportError:
        pass
    cookies = settings.youtube_cookies_file
    return HealthResponse(
        device=settings.demucs_device,
        cuda=cuda,
        library_dir=str(settings.library_dir),
        model=settings.demucs_model,
        youtube_cookies=bool(cookies and cookies.is_file()),
    )
