from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .runtime import ModelUnavailableError, SpeechRequest, VoiceRuntime
from .settings import Settings

logger = logging.getLogger(__name__)

app = FastAPI(title="Discord Anime AI Voice Service", version="0.1.0")
runtime = VoiceRuntime(Settings.from_environment())


@app.on_event("startup")
async def queue_local_model_prewarm() -> None:
    if not runtime.settings.prewarm_enabled:
        logger.info("Local model prewarm is disabled.")
        return

    async def warm_models() -> None:
        logger.info("Starting background local model prewarm (Whisper, Kokoro).")
        result = await run_in_threadpool(runtime.prewarm)
        logger.info("Background local model prewarm finished: %s", result)

    asyncio.create_task(warm_models(), name="voice-model-prewarm")


class VoiceProfilePayload(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    version: int = Field(ge=1)
    provider: str
    language: str
    settings: dict[str, str | int | float | bool] = Field(default_factory=dict)
    status: str


class SpeechPayload(BaseModel):
    text: str = Field(min_length=1, max_length=4_000)
    voiceProfile: VoiceProfilePayload


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "loadedModels": runtime.loaded_models(),
        "stt": runtime.stt_status(),
        "warmup": runtime.warmup_status(),
    }


@app.post("/v1/transcriptions")
async def transcriptions(request: Request) -> dict[str, object]:
    content_type = request.headers.get("content-type", "").lower()
    expected = "audio/l16;rate=48000;channels=2"
    if expected not in content_type:
        raise HTTPException(status_code=415, detail=f"Content-Type은 {expected}여야 합니다.")

    pcm = await request.body()
    requested_language = request.headers.get("x-stt-language", "auto")
    try:
        text, confidence = await run_in_threadpool(runtime.transcribe_pcm, pcm, requested_language)
    except ModelUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # 모델 내부 오류는 원본 오디오를 로그에 남기지 않는다.
        logger.exception("Speech transcription failed")
        raise HTTPException(status_code=502, detail="음성 인식에 실패했습니다.") from error

    return {"text": text, "confidence": confidence}


@app.post("/v1/speech")
async def speech(payload: SpeechPayload) -> Response:
    profile = payload.voiceProfile
    try:
        ogg_opus = await run_in_threadpool(
            runtime.synthesize_ogg_opus,
            SpeechRequest(
                text=payload.text,
                profile_id=profile.id,
                provider=profile.provider,
                language=profile.language,
                settings=profile.settings,
            ),
        )
    except ModelUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # 생성 텍스트/보이스 설정 외 원본 오디오는 이 경로에 없다.
        raise HTTPException(status_code=502, detail="음성 합성에 실패했습니다.") from error

    return Response(content=ogg_opus, media_type="audio/ogg; codecs=opus")

@app.post("/v1/speech/stream")
async def speech_stream(payload: SpeechPayload) -> StreamingResponse:
    profile = payload.voiceProfile
    request = SpeechRequest(
        text=payload.text,
        profile_id=profile.id,
        provider=profile.provider,
        language=profile.language,
        settings=profile.settings,
    )
    try:
        iterator = runtime.synthesize_pcm_stream(request)
        # Prime once before headers are sent so unavailable models and invalid
        # profiles still become ordinary HTTP errors instead of broken audio.
        first_chunk = await run_in_threadpool(next_stream_chunk, iterator)
    except ModelUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        logger.exception("Speech synthesis failed for provider=%s", profile.provider)
        raise HTTPException(status_code=502, detail="Speech synthesis failed.") from error

    def chunks():
        yield first_chunk
        yield from iterator

    return StreamingResponse(chunks(), media_type="audio/L16;rate=48000;channels=2")


def next_stream_chunk(iterator):
    try:
        return next(iterator)
    except StopIteration as error:
        raise ValueError("Speech synthesis produced no audio.") from error