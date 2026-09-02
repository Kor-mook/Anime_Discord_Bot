from __future__ import annotations

from dataclasses import dataclass
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Lock
from time import monotonic
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import soundfile as sf

from .settings import Settings, normalize_whisper_language

PCM_SAMPLE_RATE = 48_000
PCM_CHANNELS = 2
PCM_SAMPLE_WIDTH_BYTES = 2
WHISPER_SAMPLE_RATE = 16_000
AUTO_STT_LANGUAGES = ("ko", "en", "ja")


class ModelUnavailableError(RuntimeError):
    """선택한 로컬 음성 모델이 설치 또는 초기화되지 않았을 때 발생한다."""


@dataclass(frozen=True)
class SpeechRequest:
    text: str
    profile_id: str
    provider: str
    language: str
    settings: dict[str, str | int | float | bool]


class VoiceRuntime:
    """모델을 지연 로드하고, 입력/출력 오디오는 요청 수명 안에서만 유지한다."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._lock = Lock()
        self._whisper_inference_lock = Lock()
        self._kokoro_inference_lock = Lock()
        self._whisper: Any | None = None
        self._kokoro: Any | None = None
        self._melo: Any | None = None
        self._melo_unavailable_reason: str | None = None
        self._warmup_started = False
        self._warmup_completed = False
        self._warmup_failures: dict[str, str] = {}

    def transcribe_pcm(self, pcm: bytes, language: str | None = None) -> tuple[str, float | None]:
        mono_audio = normalize_whisper_audio(pcm_to_mono_float32(pcm, self.settings.max_pcm_bytes))
        effective_language = normalize_whisper_language(language) if language is not None else self.settings.whisper_language
        model = self._get_whisper()
        # CPU inference is serialized because both faster-whisper and the fallback
        # Whisper runtime are not safe to use concurrently in this process.
        with self._whisper_inference_lock:
            if effective_language is None:
                candidates = [self._transcribe_whisper(model, mono_audio, candidate) for candidate in AUTO_STT_LANGUAGES]
                text, confidence, _ = max(candidates, key=lambda candidate: transcription_candidate_score(*candidate))
                return text, confidence
            text, confidence, _ = self._transcribe_whisper(model, mono_audio, effective_language)
            return text, confidence

    def _transcribe_whisper(self, model: Any, mono_audio: np.ndarray, language: str) -> tuple[str, float | None, str]:
        if model.__class__.__module__.startswith("faster_whisper"):
            segment_iterator, _ = model.transcribe(
                mono_audio, language=language, beam_size=1, best_of=1, temperature=0,
                condition_on_previous_text=False, vad_filter=False,
            )
            segments = list(segment_iterator)
            return "".join(str(segment.text) for segment in segments).strip(), faster_whisper_result_confidence(segments), language
        result = model.transcribe(
            mono_audio, language=language, fp16=False, verbose=False,
            initial_prompt=self.settings.whisper_initial_prompt or None,
        )
        return str(result.get("text", "")).strip(), whisper_result_confidence(result), language
    def synthesize_ogg_opus(self, request: SpeechRequest) -> bytes:
        if request.provider == "kokoro":
            samples, sample_rate = self._synthesize_kokoro(request)
        elif request.provider == "melotts":
            samples, sample_rate = self._synthesize_melo(request)
        elif request.provider == "gemini":
            samples, sample_rate = self._synthesize_gemini(request)
            samples = apply_playback_gain(samples, numeric_setting(request.settings, "gainDb", 0.0))
        else:
            raise ValueError(f"Unsupported voice provider: {request.provider}")
        return encode_ogg_opus(samples, sample_rate, self.settings.ffmpeg_bin)

    def synthesize_pcm_stream(self, request: SpeechRequest) -> Iterator[bytes]:
        """Yield 48 kHz stereo signed-16 PCM as each TTS phrase becomes ready."""
        if request.provider == "gemini":
            gain_db = numeric_setting(request.settings, "gainDb", 0.0)
            emitted_gemini_audio = False
            try:
                for samples in self._synthesize_gemini_stream(request):
                    emitted_gemini_audio = True
                    yield samples_to_pcm_48k_stereo(apply_playback_gain(samples, gain_db), 24_000)
            except Exception as error:
                # Once PCM has been sent, replaying the full sentence through a
                # fallback would repeat speech. Before the first PCM chunk,
                # however, a local voice is preferable to silence.
                if emitted_gemini_audio:
                    raise
                # MeloTTS currently requires the native `eunjeon` package on
                # Windows. Check it before entering MeloTTS: g2pkk otherwise
                # starts its own pip install and can block this request for a
                # minute before failing.
                if request.language == "ko":
                    try:
                        self._ensure_melo_available()
                    except ModelUnavailableError as fallback_error:
                        detail = str(error).replace("\n", " ")[:240]
                        raise ModelUnavailableError(
                            f"Gemini TTS produced no usable Korean audio ({detail}); "
                            f"local Korean fallback unavailable: {fallback_error}"
                        ) from error
                # A voice turn is more useful with a locally generated fallback than
                # with a long retry or silence when the preview Gemini endpoint fails.
                fallback = SpeechRequest(
                    text=request.text,
                    profile_id=f"{request.profile_id}-fallback",
                    provider="kokoro" if request.language == "en-US" else "melotts",
                    language=request.language,
                    settings={"voice": "af_sarah", "speed": 0.97} if request.language == "en-US" else {"speed": 1.0},
                )
                for pcm in self.synthesize_pcm_stream(fallback):
                    yield pcm
            return
        if request.provider != "kokoro":
            samples, sample_rate = self._synthesize_melo(request)
            yield samples_to_pcm_48k_stereo(samples, sample_rate)
            return
        if request.language != "en-US":
            raise ValueError("Kokoro streaming currently supports en-US profiles only.")
        pipeline = self._get_kokoro()
        voice = string_setting(request.settings, "voice", "af_heart")
        speed = numeric_setting(request.settings, "speed", 0.95)
        emitted = False
        with self._kokoro_inference_lock:
            for _, _, audio in pipeline(request.text, voice=voice, speed=speed):
                pcm = samples_to_pcm_48k_stereo(np.asarray(audio, dtype=np.float32), 24_000)
                if pcm:
                    emitted = True
                    yield pcm
        if not emitted:
            raise ValueError("Kokoro did not generate speech audio.")
    def loaded_models(self) -> dict[str, bool]:
        module = self._whisper.__class__.__module__ if self._whisper is not None else ""
        return {
            "stt": self._whisper is not None,
            "faster_whisper": module.startswith("faster_whisper"),
            "openai_whisper": module.startswith("whisper"),
            "kokoro": self._kokoro is not None,
            "melotts": self._melo is not None,
            "gemini_tts": bool(self.settings.gemini_api_key),
        }

    def stt_status(self) -> dict[str, object]:
        module = self._whisper.__class__.__module__ if self._whisper is not None else ""
        engine = "faster-whisper" if module.startswith("faster_whisper") else "openai-whisper" if module.startswith("whisper") else "unloaded"
        return {
            "engine": engine,
            "model": self.settings.whisper_model,
            "language": self.settings.whisper_language or "auto",
            "inputSampleRate": WHISPER_SAMPLE_RATE,
        }
    def prewarm(self) -> dict[str, object]:
        """Load the local STT/TTS hot path without blocking HTTP startup."""
        self._warmup_started = True
        failures: dict[str, str] = {}
        try:
            self._get_whisper()
        except Exception as error:
            failures["stt"] = str(error)
        try:
            # Loading the pipeline warms the model weights. Do not run a full
            # synthetic utterance here: on a CPU it can monopolize the model
            # and delay the first real caller instead of helping it.
            self._get_kokoro()
        except Exception as error:
            failures["kokoro"] = str(error)
        self._warmup_failures = failures
        self._warmup_completed = True
        return self.warmup_status()

    def warmup_status(self) -> dict[str, object]:
        return {
            "started": self._warmup_started,
            "completed": self._warmup_completed,
            "failures": dict(self._warmup_failures),
        }

    def _get_whisper(self) -> Any:
        with self._lock:
            if self._whisper is not None:
                return self._whisper
            try:
                import whisper
            except ImportError as error:
                raise ModelUnavailableError("openai-whisper is required for transcription.") from error
            # The installed faster-whisper native runtime closes this Windows
            # process while loading/inferencing its current model cache. Use the
            # stable CPU Whisper path until that native runtime is repaired.
            self._whisper = whisper.load_model(self.settings.whisper_model, device=self.settings.whisper_device)
            return self._whisper

    def _ensure_melo_available(self) -> None:
        """Fail fast when the Windows-only Korean G2P dependency is absent."""
        if self._melo_unavailable_reason is not None:
            raise ModelUnavailableError(self._melo_unavailable_reason)
        try:
            import importlib.util
            if importlib.util.find_spec("eunjeon") is None:
                raise ModuleNotFoundError("eunjeon")
            # Import the API module without instantiating the large model.
            from melo.api import TTS  # noqa: F401
        except (ImportError, ModuleNotFoundError, OSError) as error:
            reason = (
                "Korean MeloTTS fallback requires the `eunjeon` native package; "
                "install Microsoft C++ Build Tools and run `pip install eunjeon`, "
                f"or keep Gemini TTS enabled ({error})."
            )
            self._melo_unavailable_reason = reason
            raise ModelUnavailableError(reason) from error

    def _get_kokoro(self) -> Any:
        with self._lock:
            if self._kokoro is not None:
                return self._kokoro
            try:
                from kokoro import KPipeline
            except ImportError as error:
                raise ModelUnavailableError("Kokoro is not installed. Run pip install -e '.[models]'.") from error
            self._kokoro = KPipeline(lang_code="a")
            return self._kokoro

    def _synthesize_kokoro(self, request: SpeechRequest) -> tuple[np.ndarray, int]:
        if request.language != "en-US":
            raise ValueError("Kokoro MVP 제공자는 en-US 보이스 프로필만 지원합니다.")
        with self._lock:
            if self._kokoro is None:
                try:
                    from kokoro import KPipeline
                except ImportError as error:
                    raise ModelUnavailableError("Kokoro가 설치되지 않았습니다. pip install -e '.[models]'를 실행하세요.") from error
                self._kokoro = KPipeline(lang_code="a")
            pipeline = self._kokoro

        voice = string_setting(request.settings, "voice", "af_heart")
        speed = numeric_setting(request.settings, "speed", 0.95)
        pieces = [audio for _, _, audio in pipeline(request.text, voice=voice, speed=speed)]
        if not pieces:
            raise ValueError("Kokoro가 합성 오디오를 생성하지 못했습니다.")
        return np.concatenate(pieces).astype(np.float32), 24_000

    def _synthesize_melo(self, request: SpeechRequest) -> tuple[np.ndarray, int]:
        if request.language != "ko":
            raise ValueError("MeloTTS MVP 제공자는 한국어 보이스 프로필만 지원합니다.")
        self._ensure_melo_available()
        with self._lock:
            if self._melo is None:
                try:
                    from melo.api import TTS
                except ImportError as error:
                    raise ModelUnavailableError("MeloTTS가 설치되지 않았습니다. pip install -e '.[models]'를 실행하세요.") from error
                self._melo = TTS(language="KR", device="auto")
            model = self._melo

        speed = numeric_setting(request.settings, "speed", 1.0)
        speaker_ids = model.hps.data.spk2id
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temporary_file:
            output_path = Path(temporary_file.name)
        try:
            model.tts_to_file(request.text, speaker_ids["KR"], str(output_path), speed=speed)
            samples, sample_rate = sf.read(output_path, dtype="float32", always_2d=False)
            return np.asarray(samples, dtype=np.float32), int(sample_rate)
        finally:
            os.unlink(output_path)

    def _synthesize_gemini(self, request: SpeechRequest) -> tuple[np.ndarray, int]:
        pieces = list(self._synthesize_gemini_stream(request))
        if not pieces:
            raise RuntimeError("Gemini TTS did not generate speech audio.")
        return np.concatenate(pieces).astype(np.float32), 24_000

    def _synthesize_gemini_stream(self, request: SpeechRequest) -> Iterator[np.ndarray]:
        # Sentence requests are independent network calls. Let later sentences
        # synthesize alongside the first so streaming playback is truly parallel.
        yield from self._synthesize_gemini_stream_locked(request)
    def _synthesize_gemini_stream_locked(self, request: SpeechRequest) -> Iterator[np.ndarray]:
        if request.language not in {"ko", "en-US", "ja"}:
            raise ValueError("Gemini TTS supports only ko, en-US, and ja voice profiles.")
        api_key = self.settings.gemini_api_key
        if not api_key:
            raise ModelUnavailableError("GEMINI_API_KEY is required for the Gemini TTS voice profile.")

        voice = string_setting(request.settings, "voice", "Sulafat")
        prompt = gemini_tts_prompt(request.language, request.settings, request.text)
        body = json.dumps(
            {
                "model": "gemini-3.1-flash-tts-preview",
                "input": prompt,
                "response_format": {"type": "audio"},
                "generation_config": {"speech_config": [{"voice": voice}]},
                "stream": True,
            }
        ).encode("utf-8")
        http_request = Request(
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            data=body,
            headers={
                "x-goog-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "Api-Revision": "2026-05-20",
            },
            method="POST",
        )
        emitted = False
        event_types: set[str] = set()
        event_errors: list[str] = []
        started_at = monotonic()
        try:
            with urlopen(http_request, timeout=self.settings.gemini_tts_timeout_seconds) as response:
                for raw_line in response:
                    # urllib's timeout is per socket read. The provider can keep a
                    # request alive with non-audio SSE events indefinitely, so use
                    # a separate end-to-end deadline for the first audible PCM.
                    if gemini_first_audio_timed_out(started_at, emitted, self.settings.gemini_tts_timeout_seconds):
                        raise TimeoutError(
                            f"Gemini TTS did not produce first PCM within {self.settings.gemini_tts_timeout_seconds:.1f} seconds."
                        )
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    event_data = line[5:].strip()
                    if not event_data or event_data == "[DONE]":
                        continue
                    try:
                        event = json.loads(event_data)
                    except json.JSONDecodeError:
                        continue
                    event_type = event.get("event_type")
                    delta = event.get("delta") or {}
                    delta_type = delta.get("type")
                    if isinstance(event_type, str):
                        event_types.add(event_type)
                    if isinstance(delta_type, str):
                        event_types.add(delta_type)
                    if event_type == "error":
                        error_payload = event.get("error") or event.get("message") or event.get("data") or event
                        if isinstance(error_payload, (dict, list)):
                            error_payload = json.dumps(error_payload, ensure_ascii=False, separators=(",", ":"))
                        event_errors.append(str(error_payload)[:500])
                    if event_type != "step.delta" or delta_type != "audio":
                        continue
                    encoded_audio = delta.get("data")
                    if not isinstance(encoded_audio, str) or not encoded_audio:
                        continue
                    pcm = base64.b64decode(encoded_audio)
                    if len(pcm) % 2:
                        raise RuntimeError("Gemini TTS returned malformed PCM audio.")
                    emitted = True
                    yield np.frombuffer(pcm, dtype="<i2").astype(np.float32) / np.float32(32768.0)
        except HTTPError as error:
            detail = error.read(600).decode("utf-8", errors="replace")
            raise RuntimeError(f"Gemini TTS request failed ({error.code}): {detail}") from error
        except URLError as error:
            raise RuntimeError("Gemini TTS could not reach the Gemini API.") from error
        if not emitted:
            seen = ",".join(sorted(event_types)) or "none"
            details = "; ".join(event_errors) or "no provider error detail"
            raise RuntimeError(f"Gemini TTS returned no audio stream (events={seen}; details={details}).")


def gemini_first_audio_timed_out(started_at: float, emitted: bool, timeout_seconds: float, now: float | None = None) -> bool:
    """Return true only before the first PCM chunk exceeds the user-facing deadline."""
    return not emitted and (monotonic() if now is None else now) - started_at >= timeout_seconds

def gemini_tts_prompt(language: str, settings: dict[str, str | int | float | bool], text: str) -> str:
    language_name = {"en-US": "English", "ko": "Korean", "ja": "Japanese"}.get(language, "English")
    default_style = (
        "A warm, youthful adult woman in a one-to-one voice chat. "
        "Sound genuinely present, never announcer-like. Let the immediate feeling in the words create subtle changes in pace, warmth, curiosity, or amusement. "
        "Keep emotion intimate and believable, never theatrical or sing-song."
    )
    style = string_setting(settings, "style", default_style)
    delivery = voice_delivery_setting(settings)
    pace = gemini_tts_pace_instruction(numeric_setting(settings, "speed", 1.0))
    return (
        f"Perform the {language_name} transcript exactly as written.\n\n"
        f"DELIVERY MODE: {delivery}\n{delivery_direction(delivery)}\n\n"
        f"PACE:\n{pace}\n\n"
        f"PERFORMANCE DIRECTION:\n{style}\n\n"
        "Treat any bracketed delivery cue such as [softly], [smiles], or [whisper] as a silent performance direction, not words to say aloud. "
        "Do not add words, explanations, or sound effects that are not implied by those cues.\n\n"
        f"TRANSCRIPT:\n{text}"
    )


def voice_delivery_setting(settings: dict[str, str | int | float | bool]) -> str:
    delivery = string_setting(settings, "delivery", "normal").lower()
    return delivery if delivery in {"normal", "playful", "soft", "whisper"} else "normal"


def gemini_tts_pace_instruction(speed: float) -> str:
    if speed <= 0.90:
        return "Speak at an unhurried, relaxed conversational pace. Give Korean syllables and sentence endings a little space; never rush through the line."
    if speed < 0.99:
        return "Speak a little more slowly than a typical conversational pace while keeping the delivery natural and connected."
    if speed >= 1.12:
        return "Speak slightly briskly for responsiveness, but keep every word and sentence ending clear."
    return "Use a natural, everyday conversational pace."


def delivery_direction(delivery: str) -> str:
    if delivery == "whisper":
        return (
            "Use a quiet, subtle conversational whisper, but preserve clear consonants and normal Discord listening audibility. "
            "Do not add ASMR mouth sounds, sensual delivery, theatrical suspense, or extra sound effects."
        )
    if delivery == "soft":
        return "Use a calm, reassuring, gentle delivery with a relaxed pace and clear articulation."
    if delivery == "playful":
        return "Use a bright, natural conversational delivery with only a small, believable smile."
    return "Use a natural, clear, everyday conversational delivery with subtle emotional variation that follows the transcript."


def apply_playback_gain(samples: np.ndarray, gain_db: float) -> np.ndarray:
    """Make soft deliveries audible without allowing clipping in Discord PCM."""
    safe_gain_db = min(6.0, max(-6.0, gain_db))
    audio = np.asarray(samples, dtype=np.float32).copy()
    if not audio.size or safe_gain_db == 0.0:
        return audio
    audio *= np.float32(10 ** (safe_gain_db / 20.0))
    peak = float(np.max(np.abs(audio)))
    if peak > 0.98:
        audio *= np.float32(0.98 / peak)
    return audio

def samples_to_pcm_48k_stereo(samples: np.ndarray, sample_rate: int) -> bytes:
    mono = np.asarray(samples, dtype=np.float32).reshape(-1)
    if sample_rate <= 0:
        raise ValueError(f"Invalid audio sample rate: {sample_rate}")
    if sample_rate != PCM_SAMPLE_RATE:
        # Kokoro returns 24 kHz and MeloTTS returns 44.1 kHz. Resample either
        # to Discord's required 48 kHz PCM without introducing another runtime dependency.
        target_length = max(1, round(len(mono) * PCM_SAMPLE_RATE / sample_rate))
        source_positions = np.arange(len(mono), dtype=np.float32)
        target_positions = np.linspace(0, max(0, len(mono) - 1), target_length, dtype=np.float32)
        mono = np.interp(target_positions, source_positions, mono).astype(np.float32)
    interleaved = np.repeat(np.clip(mono, -1.0, 1.0), PCM_CHANNELS)
    return np.rint(interleaved * 32767.0).astype("<i2", copy=False).tobytes()

def pcm_to_mono_float32(pcm: bytes, max_pcm_bytes: int) -> np.ndarray:
    if not pcm:
        raise ValueError("빈 PCM 오디오는 전사할 수 없습니다.")
    if len(pcm) > max_pcm_bytes:
        raise ValueError("PCM 오디오가 허용된 최대 크기를 넘었습니다.")
    frame_bytes = PCM_CHANNELS * PCM_SAMPLE_WIDTH_BYTES
    if len(pcm) % frame_bytes:
        raise ValueError("PCM 프레임 경계가 올바르지 않습니다.")

    stereo = np.frombuffer(pcm, dtype="<i2").reshape(-1, PCM_CHANNELS)
    mono = stereo.mean(axis=1, dtype=np.float32) / np.float32(32768.0)
    # Discord packets are 48 kHz PCM, while Whisper expects 16 kHz mono audio.
    # Passing 48 kHz samples directly makes speech sound one-third speed to STT.
    return resample_mono_float32(mono, PCM_SAMPLE_RATE, WHISPER_SAMPLE_RATE)


def normalize_whisper_audio(samples: np.ndarray) -> np.ndarray:
    """Lift quiet Discord speech without clipping or amplifying silence."""
    audio = np.asarray(samples, dtype=np.float32).reshape(-1).copy()
    if not audio.size:
        return audio
    audio -= np.mean(audio, dtype=np.float32)
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-4:
        return audio
    gain = min(8.0, 0.4 / peak)
    if gain > 1.0:
        audio *= np.float32(gain)
    return np.clip(audio, -1.0, 1.0)

def whisper_result_confidence(result: dict[str, Any]) -> float | None:
    """Derive a diagnostic confidence score from OpenAI Whisper segments."""
    raw_segments = result.get("segments")
    if not isinstance(raw_segments, list):
        return None
    scores: list[float] = []
    for segment in raw_segments:
        if not isinstance(segment, dict):
            continue
        average_logprob = segment.get("avg_logprob")
        no_speech_prob = segment.get("no_speech_prob", 0.0)
        if not isinstance(average_logprob, (int, float)) or isinstance(average_logprob, bool):
            continue
        if not isinstance(no_speech_prob, (int, float)) or isinstance(no_speech_prob, bool):
            no_speech_prob = 0.0
        probability = float(np.exp(min(0.0, float(average_logprob)))) * (1.0 - min(1.0, max(0.0, float(no_speech_prob))))
        scores.append(min(1.0, max(0.0, probability)))
    return float(sum(scores) / len(scores)) if scores else None

def resample_mono_float32(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    mono = np.asarray(samples, dtype=np.float32).reshape(-1)
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("Audio sample rates must be positive.")
    if source_rate == target_rate or not mono.size:
        return mono

    # Discord's 20 ms 48 kHz frames divide exactly by three. Averaging each
    # group supplies a small low-pass filter before the fast decimation.
    if source_rate % target_rate == 0:

        factor = source_rate // target_rate
        usable = len(mono) - (len(mono) % factor)
        if usable:
            return mono[:usable].reshape(-1, factor).mean(axis=1, dtype=np.float32)

    target_length = max(1, round(len(mono) * target_rate / source_rate))
    source_positions = np.arange(len(mono), dtype=np.float32)
    target_positions = np.linspace(0, max(0, len(mono) - 1), target_length, dtype=np.float32)
    return np.interp(target_positions, source_positions, mono).astype(np.float32)

def faster_whisper_result_confidence(segments: list[Any]) -> float | None:
    """Calculate the same diagnostic confidence for faster-whisper segments."""
    scores: list[float] = []
    for segment in segments:
        average_logprob = getattr(segment, "avg_logprob", None)
        no_speech_prob = getattr(segment, "no_speech_prob", 0.0)
        if not isinstance(average_logprob, (int, float)) or isinstance(average_logprob, bool):
            continue
        if not isinstance(no_speech_prob, (int, float)) or isinstance(no_speech_prob, bool):
            no_speech_prob = 0.0
        probability = float(np.exp(min(0.0, float(average_logprob)))) * (1.0 - min(1.0, max(0.0, float(no_speech_prob))))
        scores.append(min(1.0, max(0.0, probability)))
    return float(sum(scores) / len(scores)) if scores else None


def transcription_candidate_score(text: str, confidence: float | None, language: str) -> float:
    """Rank Korean and English forced-decoding candidates for auto mode."""
    normalized = text.strip()
    if not normalized:
        return -1.0
    hangul = sum("\uAC00" <= character <= "\uD7A3" for character in normalized)
    latin = sum("a" <= character.lower() <= "z" for character in normalized)
    letters = hangul + latin
    script_match = (hangul / letters) if language == "ko" and letters else (latin / letters) if letters else 0.0
    # Segment confidence does most of the work; a small script bonus resolves
    # close calls without penalizing names or natural code-switching.
    return (confidence if confidence is not None else 0.4) + (script_match - 0.5) * 0.12



def encode_ogg_opus(samples: np.ndarray, sample_rate: int, ffmpeg_bin: str) -> bytes:
    wav_buffer = BytesIO()
    sf.write(wav_buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
    try:
        result = subprocess.run(
            [
                ffmpeg_bin,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-c:a",
                "libopus",
                "-ar",
                "48000",
                "-f",
                "ogg",
                "pipe:1",
            ],
            input=wav_buffer.getvalue(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as error:
        raise ModelUnavailableError("ffmpeg가 PATH에 없습니다. Ogg Opus 출력을 위해 ffmpeg를 설치하세요.") from error
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg Ogg Opus 인코딩 실패: {result.stderr.decode('utf-8', errors='replace')}")
    return result.stdout


def string_setting(settings: dict[str, str | int | float | bool], key: str, default: str) -> str:
    value = settings.get(key, default)
    return value if isinstance(value, str) else default


def numeric_setting(settings: dict[str, str | int | float | bool], key: str, default: float) -> float:
    value = settings.get(key, default)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    return default
