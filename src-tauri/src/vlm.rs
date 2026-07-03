// vlm.rs — Vision Language Model Client
//
// Handles HTTP communication with VLM inference endpoints.
// Supports two provider types:
//   - "local" (Ollama): POST to /api/chat with model, messages[], images
//   - "cloud" (OpenAI-compatible): POST with Authorization header, vision content blocks

use serde::{Serialize, Deserialize};
use serde_json::Value;

/// A single message in the VLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmMessage {
    pub role: String,
    pub content: String,
    /// Base64-encoded images for this turn (no data URI prefix — raw base64).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub images: Vec<String>,
}

/// Response wrapper for Ollama /api/chat
#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: Option<OllamaMessageResponse>,
}

#[derive(Debug, Deserialize)]
struct OllamaMessageResponse {
    content: String,
}

/// Response wrapper for OpenAI-compatible /v1/chat/completions
#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: String,
}

/// Call the VLM with a conversation history and return the raw text response.
///
/// * `provider_type` - "local" for Ollama, "cloud" for OpenAI-compatible
/// * `endpoint`      - Full URL (e.g. "http://localhost:11434" for Ollama)
/// * `api_key`       - API key for cloud providers (None for local)
/// * `model`         - Model name (e.g. "ui-tars", "gpt-4o")
/// * `messages`      - Ordered conversation messages
pub async fn call_vlm(
    provider_type: &str,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[VlmMessage],
) -> Result<String, String> {
    match provider_type {
        "local" => call_ollama(endpoint, model, messages).await,
        "cloud" => call_openai_compatible(endpoint, api_key, model, messages).await,
        "anthropic" => call_anthropic(endpoint, api_key, model, messages).await,
        "groq" => call_groq(endpoint, api_key, model, messages).await,
        "gemini" => call_gemini(endpoint, api_key, model, messages).await,
        _ => Err(format!("Unknown provider type: {}", provider_type)),
    }
}

/// Ollama /api/chat endpoint
async fn call_ollama(
    endpoint: &str,
    model: &str,
    messages: &[VlmMessage],
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Build the Ollama chat format: each message has role, content, and optional images[]
    let ollama_messages: Vec<Value> = messages.iter().map(|m| {
        let mut msg = serde_json::json!({
            "role": m.role,
            "content": m.content,
        });
        if !m.images.is_empty() {
            msg["images"] = serde_json::json!(m.images);
        }
        msg
    }).collect();

    // Normalize endpoint: strip trailing slash, append /api/chat if not already present
    let base = endpoint.trim_end_matches('/');
    let url = if base.ends_with("/api/chat") {
        base.to_string()
    } else if base.ends_with("/api") {
        format!("{}/chat", base)
    } else {
        format!("{}/api/chat", base)
    };

    let body = serde_json::json!({
        "model": model,
        "messages": ollama_messages,
        "stream": false,
    });

    eprintln!("[vlm] POST {} (model: {}, messages: {})", url, model, messages.len());

    let response = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("VLM request failed: {}. Is Ollama running at {}?", e, endpoint))?;

    let status = response.status();
    let response_text = response.text().await
        .map_err(|e| format!("Failed to read VLM response body: {}", e))?;

    if !status.is_success() {
        return Err(format!("VLM returned HTTP {}: {}", status, response_text));
    }

    let parsed: OllamaChatResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Ollama response JSON: {} — raw: {}", e, &response_text[..200.min(response_text.len())]))?;

    parsed.message
        .map(|m| m.content)
        .ok_or_else(|| "Ollama response contained no message content".to_string())
}

/// OpenAI-compatible /v1/chat/completions endpoint
async fn call_openai_compatible(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[VlmMessage],
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Build OpenAI vision format: text + image_url content blocks
    let openai_messages: Vec<Value> = messages.iter().map(|m| {
        if m.images.is_empty() {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        } else {
            let mut content_parts = vec![
                serde_json::json!({
                    "type": "text",
                    "text": m.content,
                })
            ];
            for img in &m.images {
                content_parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:image/jpeg;base64,{}", img),
                    }
                }));
            }
            serde_json::json!({
                "role": m.role,
                "content": content_parts,
            })
        }
    }).collect();

    let base = endpoint.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    };

    let body = serde_json::json!({
        "model": model,
        "messages": openai_messages,
        "max_tokens": 1024,
    });

    eprintln!("[vlm] POST {} (model: {}, messages: {})", url, model, messages.len());

    let mut req = client.post(&url).json(&body);
    if let Some(key) = api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let response = req.send().await
        .map_err(|e| format!("VLM request failed: {}", e))?;

    let status = response.status();
    let response_text = response.text().await
        .map_err(|e| format!("Failed to read VLM response body: {}", e))?;

    if !status.is_success() {
        return Err(format!("VLM returned HTTP {}: {}", status, response_text));
    }

    let parsed: OpenAiResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse OpenAI response JSON: {} — raw: {}", e, &response_text[..200.min(response_text.len())]))?;

    parsed.choices.first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| "OpenAI response contained no choices".to_string())
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

async fn call_anthropic(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[VlmMessage],
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let anthropic_messages: Vec<Value> = messages.iter().map(|m| {
        let role = if m.role == "system" { "user" } else { &m.role };
        if m.images.is_empty() {
            serde_json::json!({
                "role": role,
                "content": m.content,
            })
        } else {
            let mut content_parts = vec![
                serde_json::json!({
                    "type": "text",
                    "text": m.content,
                })
            ];
            for img in &m.images {
                content_parts.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": img,
                    }
                }));
            }
            serde_json::json!({
                "role": role,
                "content": content_parts,
            })
        }
    }).collect();

    let base = endpoint.trim_end_matches('/');
    let url = if base.contains("/v1/messages") {
        base.to_string()
    } else {
        format!("{}/v1/messages", base)
    };

    let body = serde_json::json!({
        "model": model,
        "messages": anthropic_messages,
        "max_tokens": 1024,
    });

    let mut req = client.post(&url)
        .header("anthropic-version", "2023-06-01")
        .json(&body);

    if let Some(key) = api_key {
        req = req.header("x-api-key", key);
    }

    let response = req.send().await
        .map_err(|e| format!("Anthropic request failed: {}", e))?;

    let status = response.status();
    let response_text = response.text().await
        .map_err(|e| format!("Failed to read Anthropic response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Anthropic returned HTTP {}: {}", status, response_text));
    }

    let parsed: AnthropicResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Anthropic response JSON: {} — raw: {}", e, &response_text[..200.min(response_text.len())]))?;

    parsed.content.iter()
        .find(|c| c.content_type == "text" && c.text.is_some())
        .and_then(|c| c.text.clone())
        .ok_or_else(|| "Anthropic response contained no text content".to_string())
}

async fn call_groq(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[VlmMessage],
) -> Result<String, String> {
    call_openai_compatible(endpoint, api_key, model, messages).await
}

#[derive(Debug, Deserialize, Clone)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Debug, Deserialize, Clone)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize, Clone)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize, Clone)]
struct GeminiPart {
    text: Option<String>,
}

async fn call_gemini(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[VlmMessage],
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let gemini_contents: Vec<Value> = messages.iter().map(|m| {
        let role = if m.role == "assistant" { "model" } else { "user" };
        let mut parts = vec![
            serde_json::json!({
                "text": m.content,
            })
        ];
        for img in &m.images {
            parts.push(serde_json::json!({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": img,
                }
            }));
        }
        serde_json::json!({
            "role": role,
            "parts": parts,
        })
    }).collect();

    let base = endpoint.trim_end_matches('/');
    let key = api_key.unwrap_or("");
    let url = if base.contains("/v1beta/models") {
        format!("{}?key={}", base, key)
    } else {
        format!("{}/v1beta/models/{}:generateContent?key={}", base, model, key)
    };

    let body = serde_json::json!({
        "contents": gemini_contents,
    });

    let response = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {}", e))?;

    let status = response.status();
    let response_text = response.text().await
        .map_err(|e| format!("Failed to read Gemini response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Gemini returned HTTP {}: {}", status, response_text));
    }

    let parsed: GeminiResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Gemini response JSON: {} — raw: {}", e, &response_text[..200.min(response_text.len())]))?;

    parsed.candidates
        .and_then(|cands| cands.first().cloned())
        .and_then(|cand| cand.content)
        .and_then(|content| {
            let texts: Vec<String> = content.parts.iter()
                .filter_map(|p| p.text.clone())
                .collect();
            if texts.is_empty() { None } else { Some(texts.join("\n")) }
        })
        .ok_or_else(|| "Gemini response contained no text candidates".to_string())
}
