from __future__ import annotations

import unittest

import numpy as np

from voice_service.runtime import SpeechRequest, VoiceRuntime, gemini_first_audio_timed_out, gemini_tts_prompt, pcm_to_mono_float32, normalize_whisper_audio, numeric_setting, string_setting, apply_playback_gain, whisper_result_confidence
from voice_service.settings import Settings, normalize_whisper_language


class RuntimeTest(unittest.TestCase):
    def test_pcm_is_downmixed_and_resampled_for_whisper(self) -> None:
        pcm = np.array(
            [[32767, -32768], [32767, -32768], [32767, -32768], [16384, 16384], [16384, 16384], [16384, 16384]],
            dtype="<i2",
        ).tobytes()

        samples = pcm_to_mono_float32(pcm, max_pcm_bytes=64)

        np.testing.assert_allclose(samples, np.array([-1 / 65536, 0.5], dtype=np.float32), rtol=0, atol=1e-6)

    def test_pcm_rejects_misaligned_frames(self) -> None:
        with self.assertRaises(ValueError):
            pcm_to_mono_float32(b"abc", max_pcm_bytes=64)

    def test_whisper_segment_confidence_is_available_only_for_valid_segments(self) -> None:
        self.assertAlmostEqual(
            whisper_result_confidence({"segments": [{"avg_logprob": 0.0, "no_speech_prob": 0.2}]}),
            0.8,
        )
        self.assertIsNone(whisper_result_confidence({"segments": []}))
    def test_whisper_receives_the_seline_prompt_with_16khz_audio(self) -> None:
        runtime = VoiceRuntime(
            Settings(
                whisper_model="tiny.en",
                whisper_device="cpu",
                whisper_compute_type="int8",
                whisper_language="en",
                max_pcm_bytes=64,
                ffmpeg_bin="ffmpeg",
                gemini_api_key=None,
            )
        )
        calls: list[dict[str, object]] = []

        class FakeWhisper:
            def transcribe(self, audio, **kwargs):
                calls.append({"samples": len(audio), **kwargs})
                return {"text": "Seline"}

        runtime._whisper = FakeWhisper()
        pcm = np.zeros((6, 2), dtype="<i2").tobytes()

        text, _ = runtime.transcribe_pcm(pcm)

        self.assertEqual(text, "Seline")
        self.assertEqual(
            calls,
            [{"samples": 2, "language": "en", "fp16": False, "verbose": False, "initial_prompt": "Seline, 셀린. Hello Seline. 안녕 셀린."}],
        )
    def test_requested_stt_language_overrides_the_session_default(self) -> None:
        runtime = VoiceRuntime(
            Settings(
                whisper_model="base",
                whisper_device="cpu",
                whisper_compute_type="int8",
                whisper_language=None,
                max_pcm_bytes=64,
                ffmpeg_bin="ffmpeg",
                gemini_api_key=None,
            )
        )
        calls: list[dict[str, object]] = []

        class FakeWhisper:
            def transcribe(self, audio, **kwargs):
                calls.append(kwargs)
                return {"text": "셀린"}

        runtime._whisper = FakeWhisper()
        pcm = np.zeros((6, 2), dtype="<i2").tobytes()
        runtime.transcribe_pcm(pcm, "ko")
        runtime.transcribe_pcm(pcm, "auto")

        self.assertEqual(calls[0]["language"], "ko")
        self.assertEqual(calls[1]["language"], "ko")
        self.assertEqual(calls[2]["language"], "en")
        self.assertIsNone(normalize_whisper_language("auto"))
        self.assertEqual(normalize_whisper_language("English"), "en")
        self.assertEqual(normalize_whisper_language("ko-KR"), "ko")
    def test_quiet_whisper_audio_is_normalized_without_clipping(self) -> None:
        quiet = np.array([0.01, -0.01, 0.02, -0.02], dtype=np.float32)
        normalized = normalize_whisper_audio(quiet)
        self.assertGreater(float(np.max(np.abs(normalized))), 0.1)
        self.assertLessEqual(float(np.max(np.abs(normalized))), 1.0)
    def test_settings_helpers_do_not_accept_booleans_as_speed(self) -> None:
        self.assertEqual(numeric_setting({"speed": True}, "speed", 0.95), 0.95)
        self.assertEqual(string_setting({"voice": "af_heart"}, "voice", "fallback"), "af_heart")

    def test_whisper_gain_keeps_soft_audio_audible_without_clipping(self) -> None:
        adjusted = apply_playback_gain(np.array([0.5, -0.5], dtype=np.float32), 6.0)

        self.assertAlmostEqual(float(np.max(np.abs(adjusted))), 0.98, places=6)
        np.testing.assert_allclose(
            apply_playback_gain(np.array([0.2], dtype=np.float32), 0.0),
            np.array([0.2], dtype=np.float32),
        )
    def test_gemini_tts_english_prompt_uses_style_and_delivery_cues(self) -> None:
        prompt = gemini_tts_prompt(
            'en-US',
            {'style': 'warm and quietly playful'},
            '[softly] Hey, I missed you.'
        )

        self.assertIn('Perform the English transcript exactly as written.', prompt)
        self.assertIn('warm and quietly playful', prompt)
        self.assertIn('silent performance direction', prompt)
        self.assertIn('[softly] Hey, I missed you.', prompt)

    def test_gemini_tts_korean_prompt_slows_a_low_speed_profile(self) -> None:
        prompt = gemini_tts_prompt('ko', {'speed': 0.88}, '음… 조금 조용하네. 무슨 생각 하고 있어?')

        self.assertIn('Perform the Korean transcript exactly as written.', prompt)
        self.assertIn('Speak at an unhurried, relaxed conversational pace.', prompt)
        self.assertIn('Korean syllables and sentence endings', prompt)

    def test_gemini_tts_whisper_prompt_preserves_audibility_and_boundaries(self) -> None:
        prompt = gemini_tts_prompt('en-US', {'delivery': 'whisper'}, '[whisper] Keep this between us.')

        self.assertIn('DELIVERY MODE: whisper', prompt)
        self.assertIn('normal Discord listening audibility', prompt)
        self.assertIn('Do not add ASMR mouth sounds', prompt)
        self.assertIn('[whisper] Keep this between us.', prompt)
    def test_gemini_timeout_falls_back_to_local_voice_before_first_pcm(self) -> None:
        runtime = VoiceRuntime(
            Settings(
                whisper_model="tiny",
                whisper_device="cpu",
                whisper_compute_type="int8",
                whisper_language="en",
                max_pcm_bytes=1024,
                ffmpeg_bin="ffmpeg",
                gemini_api_key="test-key",
            )
        )
        request = SpeechRequest(
            text="Hello there.",
            profile_id="test-profile",
            provider="gemini",
            language="en-US",
            settings={},
        )

        def timed_out_stream(_request):
            raise TimeoutError("The read operation timed out")
            yield np.array([0.0], dtype=np.float32)

        runtime._synthesize_gemini_stream = timed_out_stream  # type: ignore[method-assign]
        runtime._kokoro = lambda *_args, **_kwargs: [
            (None, None, np.array([0.1, -0.1], dtype=np.float32))
        ]

        pcm_chunks = list(runtime.synthesize_pcm_stream(request))

        self.assertEqual(len(pcm_chunks), 1)
        self.assertGreater(len(pcm_chunks[0]), 0)

    def test_gemini_tts_does_not_retry_an_empty_stream_before_fallback(self) -> None:
        runtime = VoiceRuntime(
            Settings(
                whisper_model="tiny",
                whisper_device="cpu",
                whisper_compute_type="int8",
                whisper_language="en",
                max_pcm_bytes=1024,
                ffmpeg_bin="ffmpeg",
                gemini_api_key="test-key",
            )
        )
        request = SpeechRequest(
            text="Hello there.",
            profile_id="test-profile",
            provider="gemini",
            language="en-US",
            settings={},
        )
        attempts = 0

        def fake_stream(_request):
            nonlocal attempts
            attempts += 1
            raise RuntimeError("Gemini TTS returned no audio stream.")
            yield np.array([0.0], dtype=np.float32)

        runtime._synthesize_gemini_stream_locked = fake_stream  # type: ignore[method-assign]
        with self.assertRaisesRegex(RuntimeError, "returned no audio stream"):
            list(runtime._synthesize_gemini_stream(request))

        self.assertEqual(attempts, 1)
    def test_gemini_first_audio_deadline_ignores_keepalives_after_timeout(self) -> None:
        self.assertFalse(gemini_first_audio_timed_out(10.0, False, 4.0, now=13.99))
        self.assertTrue(gemini_first_audio_timed_out(10.0, False, 4.0, now=14.0))
        self.assertFalse(gemini_first_audio_timed_out(10.0, True, 4.0, now=99.0))

    def test_prewarm_loads_stt_and_kokoro_without_blocking_on_synthesis(self) -> None:
        runtime = VoiceRuntime(
            Settings(
                whisper_model="tiny",
                whisper_device="cpu",
                whisper_compute_type="int8",
                whisper_language="en",
                max_pcm_bytes=1024,
                ffmpeg_bin="ffmpeg",
                gemini_api_key="test-key",
            )
        )
        calls: list[str] = []

        def fake_whisper():
            calls.append("stt")
            return object()

        def fake_kokoro():
            calls.append("kokoro")
            return object()

        runtime._get_whisper = fake_whisper  # type: ignore[method-assign]
        runtime._get_kokoro = fake_kokoro  # type: ignore[method-assign]

        status = runtime.prewarm()

        self.assertEqual(calls, ["stt", "kokoro"])
        self.assertEqual(status, {"started": True, "completed": True, "failures": {}})
if __name__ == "__main__":
    unittest.main()
