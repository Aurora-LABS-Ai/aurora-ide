# Speech Input

Aurora speech input is local-first. The production default engine is the Rust-native
`qwen3-asr` crate, not an HTTP API and not the external CrispASR runtime.

## Default Engine

`Qwen3-ASR` loads a user-selected safetensors model folder through Rust:

- `config.json`
- `model.safetensors` or `model.safetensors.index.json`
- `tokenizer.json`, or tokenizer source files that Aurora can prepare locally

Aurora does not bundle this model. The user downloads the model separately and selects
the folder in Settings > Speech.

## Runtime Flow

1. The user enables Speech in Settings > Speech.
2. The user selects a local Qwen3-ASR model folder.
3. The chat input shows the microphone button.
4. The frontend records microphone audio in the WebView.
5. Audio is resampled to 16 kHz mono PCM.
6. The frontend sends PCM to the Tauri command `speech_transcribe_pcm`.
7. Rust loads or reuses the cached Qwen3-ASR model.
8. Rust returns the transcript.
9. The transcript is inserted into the input box.

No external speech API is called.

## CPU and GPU

The device setting is a runtime preference, but GPU support must exist in the compiled
Aurora binary.

- Default build: CPU-only, widest compatibility.
- CUDA build: compile with Aurora's `cuda` feature.
- Settings > Speech disables GPU when the current build cannot use it.

Local CUDA development:

```bash
pnpm tauri:dev:cuda
```

CUDA installer build:

```bash
pnpm tauri:build:cuda
```

CPU installer build:

```bash
pnpm tauri:build
```

On Windows, CUDA builds require both the CUDA Toolkit and Microsoft `cl.exe`.
Aurora's CUDA scripts load the Visual Studio x64 C++ environment automatically.
To verify the local build environment:

```bash
pnpm cuda:check
```

## CrispASR Compatibility

`CrispASR GGUF` is optional compatibility for users who already have a CrispASR runtime
and a GGUF speech model. Aurora runs CrispASR as a child process so a native ggml crash
cannot terminate Aurora.

Aurora does not bundle CrispASR by default. Users who choose this engine must select
their own CrispASR runtime folder in Settings > Speech.

To create a separate runtime zip for distribution:

```bash
pnpm crispasr:package -- --source "C:\Users\Alvan\AppData\Local\Aurora\crispasr-runtime\windows-x64"
```

The generated zip is written to `dist/aurora-crispasr-runtime-windows-x64.zip` by
default. Users extract it and select the extracted folder that contains
`crispasr.exe`.

## New Computer Behavior

On a fresh machine:

1. Aurora installs without a speech model.
2. Speech is disabled by default.
3. The user downloads a supported Qwen3-ASR safetensors model.
4. The user enables Speech and selects the model folder.
5. CPU builds run speech on CPU.
6. CUDA builds can run speech on GPU when CUDA device initialization succeeds.
