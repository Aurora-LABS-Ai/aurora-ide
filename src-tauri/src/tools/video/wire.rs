//! MiniMax Hailuo v1 and H3 v2 contracts. Keep their limits and wire shapes separate.
use serde::Deserialize;
use serde_json::{json, Value};

pub const MODELS: &[&str] = &[
    "MiniMax-Hailuo-2.3",
    "MiniMax-Hailuo-2.3-Fast",
    "MiniMax-H3",
    "MiniMax-H3-Max",
];

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRequest {
    #[serde(default)]
    pub prompt: String,
    pub model: Option<String>,
    pub duration: Option<u8>,
    pub resolution: Option<String>,
    pub ratio: Option<String>,
    pub first_frame: Option<String>,
    pub last_frame: Option<String>,
    #[serde(default)]
    pub reference_images: Vec<String>,
    #[serde(default)]
    pub reference_videos: Vec<String>,
    #[serde(default)]
    pub reference_audio: Vec<String>,
}

impl VideoRequest {
    pub fn model(&self) -> &str {
        self.model.as_deref().unwrap_or(MODELS[0])
    }
    pub fn v2(&self) -> bool {
        self.model().starts_with("MiniMax-H3")
    }
    pub fn duration(&self) -> u8 {
        self.duration.unwrap_or(if self.v2() { 5 } else { 6 })
    }
    pub fn resolution(&self) -> &str {
        self.resolution.as_deref().unwrap_or("768P")
    }
    pub fn has_references(&self) -> bool {
        !self.reference_images.is_empty()
            || !self.reference_videos.is_empty()
            || !self.reference_audio.is_empty()
    }
    pub fn validate(&self) -> Result<(), String> {
        if !MODELS.contains(&self.model()) {
            return Err("Unknown video model; use op 'list' for supported models".into());
        }
        let max = if self.v2() { 7000 } else { 2000 };
        if self.prompt.trim().is_empty() || self.prompt.chars().count() > max {
            return Err(format!(
                "{} requires a prompt of 1-{max} characters",
                self.model()
            ));
        }
        let duration = self.duration();
        let resolution = self.resolution();
        let valid = match self.model() {
            "MiniMax-H3" => (4..=15).contains(&duration) && ["768P", "2K"].contains(&resolution),
            "MiniMax-H3-Max" => {
                (5..=15).contains(&duration) && ["480P", "768P"].contains(&resolution)
            }
            _ => {
                (duration == 6 && ["768P", "1080P"].contains(&resolution))
                    || (duration == 10 && resolution == "768P")
            }
        };
        if !valid {
            return Err(format!(
                "Unsupported duration/resolution for {}. Use op 'list' to check limits.",
                self.model()
            ));
        }
        if self.model() == "MiniMax-Hailuo-2.3-Fast" && self.first_frame.is_none() {
            return Err("Hailuo 2.3 Fast requires a firstFrame image".into());
        }
        if !self.v2()
            && (self.last_frame.is_some() || self.has_references() || self.ratio.is_some())
        {
            return Err("Hailuo 2.3 supports text or first-frame input; lastFrame, references and ratio require H3".into());
        }
        if self.has_references() && (self.first_frame.is_some() || self.last_frame.is_some()) {
            return Err("Reference inputs cannot be combined with first/last frames".into());
        }
        if self.reference_images.len() > 9
            || self.reference_videos.len() > 3
            || self.reference_audio.len() > 3
        {
            return Err("H3 permits at most 9 reference images, 3 videos and 3 audio clips".into());
        }
        if let Some(ratio) = &self.ratio {
            if (self.first_frame.is_some() || self.last_frame.is_some()) && ratio != "adaptive" {
                return Err("H3 frame-guided video requires adaptive ratio".into());
            }
            if !["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].contains(&ratio.as_str())
            {
                return Err("Unsupported video ratio".into());
            }
            if ratio == "adaptive"
                && !self.has_references()
                && self.first_frame.is_none()
                && self.last_frame.is_none()
            {
                return Err("Text-to-video requires a concrete ratio, not adaptive".into());
            }
        }
        Ok(())
    }
    pub fn body(&self) -> Value {
        if !self.v2() {
            let mut body = json!({"model":self.model(),"prompt":self.prompt.trim(),"duration":self.duration(),"resolution":self.resolution(),"prompt_optimizer":false});
            if let Some(image) = &self.first_frame {
                body["first_frame_image"] = json!(image);
            }
            return body;
        }
        let mut content = vec![json!({"type":"text","text":self.prompt.trim()})];
        for (role, images) in [
            ("first_frame", self.first_frame.iter().collect::<Vec<_>>()),
            ("last_frame", self.last_frame.iter().collect()),
            ("reference_image", self.reference_images.iter().collect()),
        ] {
            for url in images {
                content.push(json!({"type":"image_url","image_url":{"url":url},"role":role}));
            }
        }
        for (kind, role, urls) in [
            ("video_url", "reference_video", &self.reference_videos),
            ("audio_url", "reference_audio", &self.reference_audio),
        ] {
            for url in urls {
                content.push(json!({"type":kind,kind:{"url":url},"role":role}));
            }
        }
        let frame = self.first_frame.is_some() || self.last_frame.is_some();
        let ratio = if frame {
            "adaptive"
        } else {
            self.ratio.as_deref().unwrap_or(if self.has_references() {
                "adaptive"
            } else {
                "16:9"
            })
        };
        json!({"model":self.model(),"content":content,"duration":self.duration(),"resolution":self.resolution(),"ratio":ratio})
    }
}

pub fn check_response(status: u16, body: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| format!("MiniMax returned HTTP {status} with unreadable JSON"))?;
    if let Some(code) = value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
    {
        return Err(format!(
            "MiniMax {code}: {}",
            value
                .pointer("/base_resp/status_msg")
                .and_then(Value::as_str)
                .unwrap_or("Request refused")
        ));
    }
    if !(200..300).contains(&status) || value.get("error").is_some() {
        return Err(format!(
            "MiniMax HTTP {status}: {}",
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Request refused")
        ));
    }
    Ok(value)
}

pub fn state(value: &Value, v2: bool) -> Result<(&str, Option<String>), String> {
    let status = if v2 {
        value.pointer("/task/status")
    } else {
        value.get("status")
    }
    .and_then(Value::as_str)
    .ok_or("MiniMax returned no task status")?;
    let normalized = match status.to_ascii_lowercase().as_str() {
        "preparing" | "queueing" | "queued" => "queued",
        "processing" | "running" => "running",
        "success" | "succeeded" => "succeeded",
        "fail" | "failed" => "failed",
        "cancelled" => "cancelled",
        _ => return Err(format!("Unrecognized MiniMax task status: {status}")),
    };
    let output = if v2 {
        value
            .pointer("/task/content/url")
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        value.get("file_id").and_then(|id| {
            id.as_str()
                .map(str::to_string)
                .or_else(|| id.as_u64().map(|id| id.to_string()))
        })
    };
    Ok((normalized, output))
}

pub fn media_url(value: &str) -> bool {
    if let Some(id) = value.strip_prefix("mm_file://") {
        return !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    }
    reqwest::Url::parse(value).is_ok_and(|u| {
        matches!(u.scheme(), "https" | "http")
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_to_subscription_hailuo_not_paid_h3() {
        let r = VideoRequest {
            prompt: "A landscape".into(),
            ..Default::default()
        };
        r.validate().unwrap();
        assert_eq!(r.body()["model"], "MiniMax-Hailuo-2.3");
        assert_eq!(r.body()["duration"], 6);
        assert!(r.body().get("content").is_none());
    }
    #[test]
    fn h3_multimodal_uses_nested_urls_and_rejects_mixed_modes() {
        let mut r = VideoRequest {
            model: Some("MiniMax-H3".into()),
            prompt: "A landscape".into(),
            reference_videos: vec!["https://example.com/v.mp4".into()],
            ..Default::default()
        };
        r.validate().unwrap();
        assert_eq!(
            r.body()["content"][1]["video_url"]["url"],
            "https://example.com/v.mp4"
        );
        r.first_frame = Some("image.png".into());
        assert!(r.validate().is_err());
    }
    #[test]
    fn rejects_model_limits_and_normalizes_real_statuses() {
        for (model, duration, resolution) in [
            ("MiniMax-H3-Max", 4, "768P"),
            ("MiniMax-H3-Max", 5, "2K"),
            ("MiniMax-Hailuo-2.3", 10, "1080P"),
        ] {
            assert!(VideoRequest {
                model: Some(model.into()),
                prompt: "p".into(),
                duration: Some(duration),
                resolution: Some(resolution.into()),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        assert_eq!(
            state(&json!({"status":"Success","file_id":"42"}), false).unwrap(),
            ("succeeded", Some("42".into()))
        );
        assert_eq!(
            state(&json!({"task":{"status":"queued"}}), true).unwrap().0,
            "queued"
        );
        assert!(state(&json!({"status":"not-a-state"}), false).is_err());
        assert!(check_response(
            200,
            r#"{"base_resp":{"status_code":1008,"status_msg":"Insufficient balance"}}"#
        )
        .unwrap_err()
        .contains("1008"));
        assert!(!media_url("file:///secret"));
        assert!(!media_url("https://user:pass@example.com"));
    }
}
