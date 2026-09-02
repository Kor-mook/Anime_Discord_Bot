# Voice Service

Discord 봇이 원본 PCM을 메모리에서 전송하면 이 서비스가 `faster-whisper`로 전사하고, `MeloTTS` 또는 `Kokoro`로 합성한 뒤 Ogg Opus 바이트를 반환한다.

## 설치

모델 가중치는 설치·첫 실행 시 내려받으며 Git에 저장하지 않는다.

```powershell
cd apps/voice-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[models]"
```

MeloTTS는 Windows에서 호환성 문제가 있을 수 있으므로, 문제가 발생하면 해당 제공자만 Docker/Linux 환경으로 옮긴다. API 경계는 변하지 않는다.
For the Korean MeloTTS fallback on Windows, install Microsoft C++ Build Tools before `pip install -e ".[models]"`; the optional model dependencies include `eunjeon`.


## 실행

```powershell
$env:WHISPER_MODEL='small'
$env:WHISPER_DEVICE='cpu'
$env:WHISPER_COMPUTE_TYPE='int8'
uvicorn voice_service.main:app --host 127.0.0.1 --port 8000
```

`POST /v1/transcriptions`는 48kHz, 스테레오, signed 16-bit little-endian PCM만 받는다. `POST /v1/speech`는 Discord가 바로 재생할 수 있는 `audio/ogg; codecs=opus`를 반환한다.
