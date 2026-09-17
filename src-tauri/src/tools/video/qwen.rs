//! Qwen / DashScope video (Wan 3.0). Submit-then-query, like every video API
//! this provider publishes: there is no synchronous video endpoint at all.
//!
//! Contracts, read 2026-09-15:
//! - <https://docs.qwencloud.com/api-reference/video-generation/wan30-video/create-task.md>
//! - <https://docs.qwencloud.com/api-reference/video-generation/wan30-video/query-result.md>
//!
//! Four things differ from MiniMax and each one is a failed submission if it
//! is assumed away:
//!
//! 1. **`X-DashScope-Async: enable` is mandatory on the submit.** Without it
//!    the request is not accepted as a task at all.
//! 2. Every input picture, frame or clip goes in ONE `input.media` array, each
//!    entry tagged with its own `type`, rather than in separate fields.
//! 3. The task is read back with `GET /api/v1/tasks/{id}`, not a vendor query
//!    path, and the finished video is a direct URL. There is no second
//!    file-retrieval call the way MiniMax's v1 needs one.
//! 4. `task_id` and the finished video URL both expire after 24 hours, and an
//!    expired task answers `UNKNOWN` rather than an error.

use super::wire::{media_url, VideoRequest};
use serde_json::{json, Value};

pub const MODELS: &[&str] = &["wan3.0-video", "wan3.0-video-prime"];

/// Where a task is submitted. Relative to the provider's base address.
pub const SUBMIT_PATH: &str = "api/v1/services/aigc/video-generation/video-synthesis";

/// The header that makes a submission a task. Not optional.
pub const ASYNC_HEADER: (&str, &str) = ("X-DashScope-Async", "enable");

/// Reading one task back.
#[must_use]
pub fn query_path(task: &str) -> String {
    format!("api/v1/tasks/{task}")
}

pub const RESOLUTIONS: &[&str] = &["480P", "720P", "1080P"];
pub const RATIOS: &[&str] = &["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

/// Aurora's default, not the provider's.
///
/// Wan 3.0 defaults to 1080P, which is the most expensive tier it sells. The
/// same rule the MiniMax path follows applies here: never spend the user's
/// money at the top tier because they did not name one. The schema says so out
/// loud so the model can ask for 1080P when the user actually wants it.
pub const DEFAULT_RESOLUTION: &str = "720P";
pub const DEFAULT_DURATION: u8 = 5;

pub fn model(request: &VideoRequest) -> &str {
    request.model.as_deref().unwrap_or(MODELS[0])
}

pub fn duration(request: &VideoRequest) -> u8 {
    request.duration.unwrap_or(DEFAULT_DURATION)
}

pub fn resolution(request: &VideoRequest) -> &str {
    request.resolution.as_deref().unwrap_or(DEFAULT_RESOLUTION)
}

pub fn validate(request: &VideoRequest) -> Result<(), String> {
    let model = model(request);
    if !MODELS.contains(&model) {
        return Err("Unknown Qwen video model; use op 'list' for supported models".into());
    }
    if request.prompt.trim().is_empty() || request.prompt.chars().count() > 20_000 {
        return Err(format!("{model} requires a prompt of 1-20000 characters"));
    }
    if !(2..=30).contains(&duration(request)) {
        return Err("Qwen video duration must be 2-30 seconds".into());
    }
    if !RESOLUTIONS.contains(&resolution(request)) {
        return Err(format!(
            "Qwen video resolution must be one of {}",
            RESOLUTIONS.join(", ")
        ));
    }
    if let Some(ratio) = &request.ratio {
        if !RATIOS.contains(&ratio.as_str()) {
            return Err("Unsupported video ratio".into());
        }
    }
    // The provider states these two modes are mutually exclusive and refuses
    // the task if both arrive. Catching it here costs nothing; catching it
    // there costs a round trip and a confusing failure.
    if request.has_references() && (request.first_frame.is_some() || request.last_frame.is_some()) {
        return Err(
            "Reference inputs cannot be combined with first/last frames on Qwen video".into(),
        );
    }
    if request.reference_videos.len() + request.reference_audio.len() > 0
        && request.reference_images.is_empty()
        && request.prompt.trim().is_empty()
    {
        return Err("Reference video or audio still needs a prompt".into());
    }
    Ok(())
}

pub fn body(request: &VideoRequest) -> Value {
    let mut media = Vec::new();
    for (kind, url) in [
        ("first_frame", request.first_frame.as_ref()),
        ("last_frame", request.last_frame.as_ref()),
    ] {
        if let Some(url) = url {
            media.push(json!({"type": kind, "url": url}));
        }
    }
    for (kind, urls) in [
        ("reference_image", &request.reference_images),
        ("reference_video", &request.reference_videos),
        ("reference_audio", &request.reference_audio),
    ] {
        for url in urls {
            media.push(json!({"type": kind, "url": url}));
        }
    }

    let mut input = json!({"prompt": request.prompt.trim()});
    if !media.is_empty() {
        input["media"] = Value::Array(media);
    }

    let ratio = request.ratio.as_deref().unwrap_or_else(|| {
        // Anything with a picture in it takes its shape from that picture.
        if request.first_frame.is_some() || request.last_frame.is_some() || request.has_references()
        {
            "adaptive"
        } else {
            "16:9"
        }
    });

    json!({
        "model": model(request),
        "input": input,
        "parameters": {
            "resolution": resolution(request),
            "ratio": ratio,
            "duration": duration(request),
            "watermark": false,
            // Same reason as the image path: the prompt already came from a
            // language model, so do not let another one rewrite it.
            "prompt_extend": false,
        },
    })
}

/// A DashScope reply, or the provider's own words about why there isn't one.
pub fn check_response(status: u16, body: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| format!("Qwen returned HTTP {status} with unreadable JSON"))?;
    // A refusal names itself with a top-level `code`, with or without a
    // failing status line. A FAILED task also carries a code, but it carries
    // an `output` with it and is a task state rather than a rejected request.
    if value.get("output").is_none() {
        if let Some(code) = value
            .get("code")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|code| !code.is_empty())
        {
            return Err(format!(
                "Qwen {code}: {}",
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Request refused")
            ));
        }
        if !(200..300).contains(&status) {
            return Err(format!("Qwen HTTP {status}: request refused"));
        }
        return Err("Qwen returned no task output".into());
    }
    if !(200..300).contains(&status) {
        return Err(format!("Qwen HTTP {status}: request refused"));
    }
    Ok(value)
}

/// The task id of a fresh submission.
#[must_use]
pub fn task_id(value: &Value) -> Option<String> {
    value
        .pointer("/output/task_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(str::to_string)
}

/// `(status, finished video URL)` in Aurora's own vocabulary.
pub fn state(value: &Value) -> Result<(&'static str, Option<String>), String> {
    let status = value
        .pointer("/output/task_status")
        .and_then(Value::as_str)
        .ok_or("Qwen returned no task status")?;
    let normalized = match status.to_ascii_uppercase().as_str() {
        "PENDING" => "queued",
        "RUNNING" => "running",
        "SUCCEEDED" => "succeeded",
        "FAILED" => "failed",
        "CANCELED" | "CANCELLED" => "cancelled",
        // Documented as what an expired task answers, not as a fault.
        "UNKNOWN" => "unknown",
        _ => return Err(format!("Unrecognized Qwen task status: {status}")),
    };
    // The reference page names `video_url` but does not show the envelope it
    // sits in verbatim, so both the documented nesting and the bare field are
    // read rather than guessed at.
    let url = ["/output/video_url", "/video_url", "/output/results/0/url"]
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .filter(|url| media_url(url) && !url.starts_with("mm_file:"))
        .map(str::to_string);
    Ok((normalized, url))
}

/// Why a task failed, in the provider's words.
#[must_use]
pub fn failure(value: &Value) -> Option<String> {
    let message = ["/output/message", "/message"]
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))?;
    let code = ["/output/code", "/code"]
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str));
    Some(match code {
        Some(code) => format!("Qwen {code}: {message}"),
        None => format!("Qwen: {message}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> VideoRequest {
        VideoRequest {
            prompt: "A slow push-in over a harbour at dawn".into(),
            model: Some("wan3.0-video".into()),
            ..Default::default()
        }
    }

    #[test]
    fn a_submission_defaults_below_the_most_expensive_tier() {
        let request = request();
        validate(&request).unwrap();
        let body = body(&request);
        assert_eq!(body["model"], "wan3.0-video");
        assert_eq!(body["input"]["prompt"], "A slow push-in over a harbour at dawn");
        // The provider's own default is 1080P. Aurora does not spend there
        // unasked.
        assert_eq!(body["parameters"]["resolution"], "720P");
        assert_eq!(body["parameters"]["duration"], 5);
        assert_eq!(body["parameters"]["ratio"], "16:9");
        assert_eq!(body["parameters"]["prompt_extend"], false);
        // Text-only means no media array at all, not an empty one.
        assert!(body["input"].get("media").is_none());
    }

    #[test]
    fn every_input_picture_lands_in_one_tagged_media_array() {
        let body = body(&VideoRequest {
            first_frame: Some("https://example.com/a.png".into()),
            reference_audio: vec!["https://example.com/a.mp3".into()],
            ..request()
        });
        let media = body["input"]["media"].as_array().unwrap();
        assert_eq!(media[0]["type"], "first_frame");
        assert_eq!(media[0]["url"], "https://example.com/a.png");
        assert_eq!(media[1]["type"], "reference_audio");
        // A frame decides the shape, so the ratio follows the picture.
        assert_eq!(body["parameters"]["ratio"], "adaptive");
    }

    #[test]
    fn the_two_input_modes_the_provider_refuses_are_refused_here_first() {
        assert!(validate(&VideoRequest {
            first_frame: Some("https://example.com/a.png".into()),
            reference_images: vec!["https://example.com/b.png".into()],
            ..request()
        })
        .is_err());
        for bad in [
            VideoRequest {
                duration: Some(31),
                ..request()
            },
            VideoRequest {
                resolution: Some("2K".into()),
                ..request()
            },
            VideoRequest {
                ratio: Some("7:5".into()),
                ..request()
            },
            VideoRequest {
                model: Some("MiniMax-Hailuo-2.3".into()),
                ..request()
            },
            VideoRequest {
                prompt: "  ".into(),
                ..request()
            },
        ] {
            assert!(validate(&bad).is_err());
        }
    }

    #[test]
    fn task_states_normalize_and_an_expired_task_is_not_a_failure() {
        assert_eq!(
            state(&json!({"output":{"task_status":"PENDING"}})).unwrap().0,
            "queued"
        );
        assert_eq!(
            state(&json!({"output":{"task_status":"UNKNOWN"}})).unwrap().0,
            "unknown"
        );
        let (status, url) = state(&json!({"output":{"task_status":"SUCCEEDED",
            "video_url":"https://dashscope-result.example/v.mp4"}}))
        .unwrap();
        assert_eq!(status, "succeeded");
        assert_eq!(url.as_deref(), Some("https://dashscope-result.example/v.mp4"));
        // A credentialed or non-HTTP address is not an address Aurora fetches.
        assert!(state(&json!({"output":{"task_status":"SUCCEEDED",
            "video_url":"https://user:pass@example.com/v.mp4"}}))
        .unwrap()
        .1
        .is_none());
        assert!(state(&json!({"output":{"task_status":"WAT"}})).is_err());
    }

    #[test]
    fn a_refusal_is_read_before_a_task_id_is_invented() {
        let error = check_response(
            400,
            r#"{"code":"InvalidParameter","message":"duration is not supported","request_id":"r"}"#,
        )
        .unwrap_err();
        assert!(error.contains("InvalidParameter"));
        assert!(error.contains("duration is not supported"));

        let ok = check_response(
            200,
            r#"{"request_id":"r","output":{"task_id":"abc-123","task_status":"PENDING"}}"#,
        )
        .unwrap();
        assert_eq!(task_id(&ok).as_deref(), Some("abc-123"));
        assert_eq!(
            failure(&json!({"output":{"code":"InternalError","message":"boom"}})).as_deref(),
            Some("Qwen InternalError: boom")
        );
    }
}
