#!/usr/bin/env python3
import argparse
import ctypes
import os
import subprocess
import struct
import sys
import wave
from pathlib import Path


DEFAULT_RUNTIME = Path(r"E:\VOID-EDITOR\Aurora-Agent-IDE\src-tauri\crispasr-runtime\windows-x64")
DEFAULT_MODEL = Path(
    r"E:\INSTAGRAM-KICKBOT-MIXED\COMPLETE-QUANTUMGRUM-SET\quantum-kick-runtime\models\qyantum-agent=asr-q8.gguf"
)
DEFAULT_WAV = Path(
    r"E:\INSTAGRAM-KICKBOT-MIXED\COMPLETE-QUANTUMGRUM-SET\quantum-kick-runtime\woodbaby_16k.wav"
)


def read_wav_mono_f32(path: Path) -> list[float]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.getnframes()
        raw = wav.readframes(frames)

    if sample_rate != 16000:
        raise ValueError(f"Expected 16 kHz WAV, got {sample_rate} Hz.")
    if channels < 1:
        raise ValueError("WAV has no audio channels.")

    if sample_width == 2:
        values = struct.unpack("<" + "h" * (len(raw) // 2), raw)
        if channels == 1:
            return [sample / 32768.0 for sample in values]
        return [
            sum(values[index : index + channels]) / channels / 32768.0
            for index in range(0, len(values), channels)
        ]

    if sample_width == 4:
        values = struct.unpack("<" + "f" * (len(raw) // 4), raw)
        if channels == 1:
            return list(values)
        return [
            sum(values[index : index + channels]) / channels
            for index in range(0, len(values), channels)
        ]

    raise ValueError(f"Unsupported WAV sample width: {sample_width} bytes.")


def load_api(runtime: Path):
    if not runtime.is_dir():
        raise FileNotFoundError(f"Runtime folder not found: {runtime}")

    dll_path = runtime / "crispasr.dll"
    if not dll_path.is_file():
        raise FileNotFoundError(f"crispasr.dll not found: {dll_path}")

    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(str(runtime))

    lib = ctypes.CDLL(str(dll_path))
    lib.crispasr_session_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
    lib.crispasr_session_open.restype = ctypes.c_void_p
    lib.crispasr_session_open_explicit.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    lib.crispasr_session_open_explicit.restype = ctypes.c_void_p
    lib.crispasr_session_close.argtypes = [ctypes.c_void_p]
    lib.crispasr_session_backend.argtypes = [ctypes.c_void_p]
    lib.crispasr_session_backend.restype = ctypes.c_char_p
    lib.crispasr_session_available_backends.argtypes = [ctypes.c_char_p, ctypes.c_int]
    lib.crispasr_session_available_backends.restype = ctypes.c_int
    lib.crispasr_session_transcribe.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int]
    lib.crispasr_session_transcribe.restype = ctypes.c_void_p
    lib.crispasr_session_transcribe_lang.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_int,
        ctypes.c_char_p,
    ]
    lib.crispasr_session_transcribe_lang.restype = ctypes.c_void_p
    lib.crispasr_session_result_n_segments.argtypes = [ctypes.c_void_p]
    lib.crispasr_session_result_n_segments.restype = ctypes.c_int
    lib.crispasr_session_result_segment_text.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.crispasr_session_result_segment_text.restype = ctypes.c_char_p
    lib.crispasr_session_result_free.argtypes = [ctypes.c_void_p]
    return lib


def list_backends(lib) -> str:
    buffer = ctypes.create_string_buffer(1024)
    lib.crispasr_session_available_backends(buffer, len(buffer))
    return buffer.value.decode("utf-8", errors="replace")


def transcribe_pcm(lib, session, pcm: list[float], language: str) -> str:
    pcm_array = (ctypes.c_float * len(pcm))(*pcm)

    if language and language != "auto":
        result = lib.crispasr_session_transcribe_lang(
            session,
            pcm_array,
            len(pcm),
            language.encode("utf-8"),
        )
    else:
        result = lib.crispasr_session_transcribe(session, pcm_array, len(pcm))

    if not result:
        raise RuntimeError("Transcription returned null.")

    try:
        segments = []
        count = lib.crispasr_session_result_n_segments(result)
        for index in range(count):
            text = lib.crispasr_session_result_segment_text(result, index)
            if text:
                segment = text.decode("utf-8", errors="replace").strip()
                if segment:
                    segments.append(segment)
        return " ".join(segments).strip()
    finally:
        lib.crispasr_session_result_free(result)


def transcribe(
    lib,
    model: Path,
    wav_path: Path,
    backend: str,
    threads: int,
    language: str,
    chunk_seconds: int,
) -> tuple[str, str]:
    pcm = read_wav_mono_f32(wav_path)
    print(f"Loaded WAV: {wav_path}")
    print(f"Samples: {len(pcm)} at 16 kHz")

    model_bytes = str(model).encode("utf-8")
    if backend == "auto":
        session = lib.crispasr_session_open(model_bytes, threads)
    else:
        session = lib.crispasr_session_open_explicit(model_bytes, backend.encode("utf-8"), threads)

    if not session:
        raise RuntimeError(f"Failed to open model. Available backends: {list_backends(lib)}")

    try:
        active_backend = lib.crispasr_session_backend(session)
        active_backend_text = active_backend.decode("utf-8", errors="replace") if active_backend else ""
        chunk_samples = max(1, chunk_seconds) * 16000
        chunks = [
            pcm[index : index + chunk_samples]
            for index in range(0, len(pcm), chunk_samples)
        ]
        print(f"Processing chunks: {len(chunks)} x {chunk_seconds}s")

        transcripts = []
        for index, chunk in enumerate(chunks, start=1):
            print(f"Transcribing chunk {index}/{len(chunks)} ({len(chunk)} samples)")
            text = transcribe_pcm(lib, session, chunk, language)
            if text:
                transcripts.append(text)
        return active_backend_text, " ".join(transcripts).strip()
    finally:
        lib.crispasr_session_close(session)


def transcribe_cli(runtime: Path, model: Path, wav_path: Path, backend: str, threads: int, language: str) -> str:
    exe = runtime / "crispasr.exe"
    if not exe.is_file():
        raise FileNotFoundError(f"crispasr.exe not found: {exe}")

    command = [
        str(exe),
        "--backend",
        backend,
        "-m",
        str(model),
        "-f",
        str(wav_path),
        "-t",
        str(threads),
        "-nt",
    ]
    if language and language != "auto":
        command.extend(["-l", language])

    env = os.environ.copy()
    env["PATH"] = f"{runtime};{env.get('PATH', '')}"
    result = subprocess.run(
        command,
        cwd=str(runtime),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "CrispASR CLI failed with exit code "
            f"{result.returncode}\nSTDERR:\n{result.stderr.strip()}"
        )

    if result.stderr.strip():
        print("Runtime log:")
        print(result.stderr.strip())

    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Load CrispASR natively and transcribe a WAV file.")
    parser.add_argument("--mode", choices=["cli", "ffi"], default="cli")
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--wav", type=Path, default=DEFAULT_WAV)
    parser.add_argument("--backend", default="qwen3")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--chunk-seconds", type=int, default=30)
    args = parser.parse_args()

    if not args.model.is_file():
        raise FileNotFoundError(f"Model file not found: {args.model}")
    if not args.wav.is_file():
        raise FileNotFoundError(f"WAV file not found: {args.wav}")

    print(f"Runtime: {args.runtime}")
    print(f"Model: {args.model}")
    print(f"Backend: {args.backend}")

    if args.mode == "cli":
        transcript = transcribe_cli(
            args.runtime,
            args.model,
            args.wav,
            args.backend.strip().lower(),
            max(1, min(args.threads, 32)),
            args.language.strip().lower(),
        )
        print("Mode: cli")
    else:
        lib = load_api(args.runtime)
        print(f"Available backends: {list_backends(lib)}")
        active_backend, transcript = transcribe(
            lib,
            args.model,
            args.wav,
            args.backend.strip().lower(),
            max(1, min(args.threads, 32)),
            args.language.strip().lower(),
            max(1, args.chunk_seconds),
        )
        print("Mode: ffi")
        print(f"Active backend: {active_backend}")

    print("Transcript:")
    print(transcript or "<empty>")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
