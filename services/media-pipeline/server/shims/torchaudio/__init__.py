"""Minimal torchaudio stand-in for NGC images without ABI-matched torchaudio."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf
import torch


def load(path: str, *args, **kwargs) -> tuple[torch.Tensor, int]:
    data, sample_rate = sf.read(str(path), always_2d=True)
    tensor = torch.from_numpy(np.asarray(data, dtype=np.float32).T.copy())
    return tensor, int(sample_rate)


def save(
    path: str,
    wav: torch.Tensor,
    sample_rate: int,
    *,
    encoding: str | None = None,
    bits_per_sample: int = 16,
    **kwargs,
) -> None:
    del kwargs
    tensor = wav.detach().cpu()
    if tensor.ndim == 1:
        tensor = tensor.unsqueeze(0)
    data = tensor.transpose(0, 1).numpy()
    suffix = Path(path).suffix.lower()
    if suffix == ".flac":
        subtype = "PCM_16"
    elif encoding == "PCM_F" or bits_per_sample == 32:
        subtype = "FLOAT"
    else:
        subtype = "PCM_16"
    sf.write(str(path), data, sample_rate, subtype=subtype)


def set_audio_backend(_backend: str) -> None:
    return None


class pipelines:  # noqa: N801 — mimic torchaudio.pipelines namespace
    class MMS_FA:  # type: ignore[no-redef]
        sample_rate = 16000

        @staticmethod
        def get_model(with_star: bool = False):
            raise RuntimeError("MMS_FA unavailable in torchaudio shim")

        @staticmethod
        def get_tokenizer():
            raise RuntimeError("MMS_FA unavailable in torchaudio shim")

        @staticmethod
        def get_aligner():
            raise RuntimeError("MMS_FA unavailable in torchaudio shim")
