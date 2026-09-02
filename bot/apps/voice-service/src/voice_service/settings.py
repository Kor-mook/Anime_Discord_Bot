from __future__ import annotations

from dataclasses import dataclass
import os


def normalize_whisper_language(value: str | None) -> str | None:
    """Map user-facing language choices to the Whisper API convention."""
    normalized = (value or "").strip().lower().replace("_", "-")
    if normalized in {"", "auto", "detect"}:
        return None
    if normalized in {"english", "en-us", "en-gb"}:
        return "en"
    if normalized in {"korean", "ko-kr"}:
        return "ko"
    if normalized in {"japanese", "ja-jp"}:
        return "ja"
    return normalized


@dataclass(frozen=True)
class Settings:
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    whisper_language: str | None
    max_pcm_bytes: int
    ffmpeg_bin: str
    gemini_api_key: str | None
    whisper_initial_prompt: str = "Seline, 셀린, セリン. Hello Seline. 안녕 셀린. こんにちはセリン。"
    prewarm_enabled: bool = True
    gemini_tts_timeout_seconds: float = 4.0

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            whisper_model=os.getenv("WHISPER_MODEL", "base"),
            whisper_device=os.getenv("WHISPER_DEVICE", "cpu"),
            whisper_compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
            whisper_language=normalize_whisper_language(os.getenv("WHISPER_LANGUAGE", "auto")),
            max_pcm_bytes=int(os.getenv("MAX_PCM_BYTES", str(12 * 1024 * 1024))),
            ffmpeg_bin=os.getenv("FFMPEG_BIN", "ffmpeg"),
            gemini_api_key=os.getenv("GEMINI_API_KEY"),
            whisper_initial_prompt=os.getenv("WHISPER_INITIAL_PROMPT", "Seline, 셀린, セリン. Hello Seline. 안녕 셀린. こんにちはセリン。").strip(),
            prewarm_enabled=os.getenv("VOICE_PREWARM_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"},
            gemini_tts_timeout_seconds=max(1.0, min(12.0, float(os.getenv("GEMINI_TTS_TIMEOUT_SECONDS", "4.0")))),
        )