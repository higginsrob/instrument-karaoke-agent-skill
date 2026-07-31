from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np

from server.config import settings

logger = logging.getLogger(__name__)

MIDI_TO_INSTRUMENT: dict[int, str] = {
    35: "kick",
    38: "snare",
    47: "tom",
    42: "hihat",
    49: "crash",
}
INSTRUMENT_TO_MIDI: dict[str, int] = {v: k for k, v in MIDI_TO_INSTRUMENT.items()}
DRUM_INSTRUMENTS = ["crash", "hihat", "snare", "tom", "kick"]
ADTOF_FPS = 100


def _resolve_device() -> str:
    device = settings.adtof_device
    if device not in ("cuda", "cpu"):
        device = "cpu"
    try:
        import torch

        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
    except ImportError:
        device = "cpu"
    return device


def _drum_hit_velocity(y: np.ndarray, sr: int, onset_time: float) -> int:
    if y.size == 0 or sr <= 0:
        return 100
    start = int(max(0.0, onset_time - 0.005) * sr)
    end = int(min(len(y), onset_time + 0.020) * sr)
    if end <= start:
        return 100
    segment = y[start:end]
    rms = float(np.sqrt(np.mean(segment * segment) + 1e-12))
    db = 20.0 * np.log10(rms + 1e-12)
    ratio = (db - (-50.0)) / ((-5.0) - (-50.0))
    ratio = max(0.0, min(1.0, ratio))
    return max(1, min(127, int(round(1 + ratio * 126))))


def _activation_at_time(activations: np.ndarray, class_index: int, time_value: float) -> float:
    frame = int(round(time_value * ADTOF_FPS))
    frame = max(0, min(activations.shape[0] - 1, frame))
    return float(activations[frame, class_index])


def transcribe_drums(path: Path) -> dict[str, Any]:
    from adtof_pytorch import (
        LABELS_5,
        PeakPicker,
        create_frame_rnn_model,
        calculate_n_bins,
        get_default_weights_path,
        load_audio_for_model,
        load_pytorch_weights,
        FRAME_RNN_THRESHOLDS,
    )
    import librosa
    import torch

    device = _resolve_device()
    thresholds = [float(v) for v in FRAME_RNN_THRESHOLDS]
    n_bins = calculate_n_bins()
    model = create_frame_rnn_model(n_bins)
    model.eval()
    weights_path = get_default_weights_path()
    if weights_path:
        model = load_pytorch_weights(model, weights_path, strict=False)
    model.to(device)

    audio_tensor = load_audio_for_model(str(path)).to(device)
    with torch.no_grad():
        pred = model(audio_tensor).cpu().numpy()
    activations = pred[0] if pred.ndim == 3 else pred

    picker = PeakPicker(thresholds=thresholds, fps=ADTOF_FPS)
    peaks = picker.pick(activations[None, ...], labels=LABELS_5, label_offset=0)[0]
    y, sr = librosa.load(str(path), sr=22050, mono=True)

    onsets: list[dict[str, Any]] = []
    for class_index, midi_pitch in enumerate(LABELS_5):
        instrument = MIDI_TO_INSTRUMENT.get(int(midi_pitch))
        if instrument is None:
            continue
        for time_value in peaks.get(int(midi_pitch), []):
            time_float = float(time_value)
            activation = _activation_at_time(activations, class_index, time_float)
            velocity = _drum_hit_velocity(y, sr, time_float)
            strength = max(activation, velocity / 127.0)
            onsets.append(
                {
                    "time": time_float,
                    "instrument": instrument,
                    "velocity": velocity,
                    "strength": float(max(0.0, min(1.0, strength))),
                }
            )
    onsets.sort(key=lambda item: item["time"])
    return {
        "engine": "adtof",
        "version": 1,
        "instruments": list(DRUM_INSTRUMENTS),
        "onsets": onsets,
    }


def write_drums_midi(beats: dict[str, Any], midi_path: Path) -> None:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI()
    drum = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for onset in beats.get("onsets") or []:
        instrument = str(onset.get("instrument") or "")
        pitch = INSTRUMENT_TO_MIDI.get(instrument)
        if pitch is None:
            continue
        start = float(onset.get("time") or 0.0)
        velocity = int(onset.get("velocity") or 100)
        note = pretty_midi.Note(
            velocity=max(1, min(127, velocity)),
            pitch=pitch,
            start=start,
            end=start + 0.05,
        )
        drum.notes.append(note)
    pm.instruments.append(drum)
    midi_path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(midi_path))


def process_drums(drums_wav: Path, media_dir: Path) -> dict[str, Any]:
    if not drums_wav.is_file():
        raise FileNotFoundError(f"Missing drums stem: {drums_wav}")
    beats = transcribe_drums(drums_wav)
    beats_path = media_dir / "drums_beats.json"
    beats_path.write_text(json.dumps(beats, indent=2), encoding="utf-8")
    midi_path = media_dir / "drums.mid"
    write_drums_midi(beats, midi_path)
    return {
        "onsets": len(beats.get("onsets") or []),
        "beats_path": beats_path.name,
        "midi_path": midi_path.name,
    }
