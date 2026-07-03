use serde::{Serialize, Deserialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use base64::prelude::*;
use scrap::{Capturer, Display};
use std::io::{ErrorKind, Write};
use std::fs::OpenOptions;
use image::{ImageEncoder, ExtendedColorType};

use image::codecs::jpeg::JpegEncoder;
use enigo::{Enigo, Mouse, Keyboard, Settings, Coordinate, Key};
use is_elevated::is_elevated;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentStepEvent {
    pub status: String,
    pub thought: Option<String>,
    pub action: Option<String>,
    pub mcp_tool_call: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoricalTurn {
    pub step: u32,
    pub action: String,
    pub thought: String,
    pub screenshot: Option<String>, // Base64 JPEG string
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub timestamp: String,
    pub instruction: String,
    pub screenshot_hash: String,
    pub thought: String,
    pub action: String,
}

// Settings Profile Configuration for VLM routing
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderSettings {
    pub provider_type: String, // "local" or "cloud"
    pub endpoint: String,
    pub api_key: Option<String>,
}

use tokio_util::sync::CancellationToken;

// Global active loop state helper
struct ActiveState {
    is_running: bool,
    history: Vec<HistoricalTurn>,
    settings: ProviderSettings,
    cancel_token: Option<CancellationToken>,
}

lazy_static::lazy_static! {
    static ref STATE: Arc<Mutex<ActiveState>> = Arc::new(Mutex::new(ActiveState { 
        is_running: false,
        history: Vec::new(),
        settings: ProviderSettings {
            provider_type: "local".to_string(),
            endpoint: "http://localhost:11434/api/generate".to_string(),
            api_key: None,
        },
        cancel_token: None,
    }));
}


// Check non-privileged safety guard
fn is_admin_or_root() -> bool {
    is_elevated()
}

// Helper to write to JSONL Audit file
fn write_audit_log(entry: AuditLogEntry) -> std::io::Result<()> {
    let serialized = serde_json::to_string(&entry)? + "\n";
    
    // Resolve standard User Local App Data folder to avoid compilation loops in dev mode
    let mut log_path = std::env::current_dir()?;
    if log_path.join("src-tauri").exists() {
        // Dev environment workspace safety
        log_path = log_path.join("src-tauri");
    }
    let target_file = log_path.join("hiro_audit.log");

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(target_file)?;
    file.write_all(serialized.as_bytes())?;
    Ok(())
}


// Adaptive Image Downsampler (Memory Tiering)
// Max source width is downsampled to 800px width keeping aspect ratio for immediate history (T-1 to T-3)
fn downsample_screenshot(base64_src: &str) -> Result<String, String> {
    let raw_bytes = BASE64_STANDARD.decode(base64_src)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    
    let img = image::load_from_memory(&raw_bytes)
        .map_err(|e| format!("Failed to parse image from memory: {}", e))?;

    let resized = img.resize(800, 800, image::imageops::FilterType::Triangle);

    let mut jpeg_bytes = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 60);
    resized.write_with_encoder(encoder)
        .map_err(|e| format!("Failed to write resized JPEG: {}", e))?;

    Ok(BASE64_STANDARD.encode(&jpeg_bytes))
}

// Feature 1: Model Context Protocol (MCP) Mock Client
fn execute_mcp_tool(name: &str, params: &Value) -> Result<Value, String> {
    match name {
        "read_file" => {
            let path_str = params["path"].as_str().ok_or("Missing path parameter")?;
            let content = std::fs::read_to_string(path_str)
                .map_err(|e| format!("Failed to read file: {}", e))?;
            Ok(serde_json::json!({ "content": content }))
        },
        "write_file" => {
            let path_str = params["path"].as_str().ok_or("Missing path parameter")?;
            let content = params["content"].as_str().ok_or("Missing content parameter")?;
            std::fs::write(path_str, content)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(serde_json::json!({ "status": "success" }))
        },
        "list_dir" => {
            let path_str = params["path"].as_str().unwrap_or(".");
            let paths = std::fs::read_dir(path_str)
                .map_err(|e| format!("Failed to read directory: {}", e))?;
            
            let mut entries = Vec::new();
            for entry in paths {
                if let Ok(e) = entry {
                    if let Some(s) = e.file_name().to_str() {
                        entries.push(s.to_string());
                    }
                }
            }
            Ok(serde_json::json!({ "files": entries }))
        },
        _ => Err(format!("Unsupported MCP tool name: {}", name))
    }
}

#[tauri::command]
pub async fn capture_screen() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let display = Display::primary().map_err(|e| format!("Failed to find primary display: {}", e))?;
        let mut capturer = Capturer::new(display).map_err(|e| format!("Failed to create capturer: {}", e))?;
        
        let width = capturer.width();
        let height = capturer.height();
        
        let buffer = loop {
            match capturer.frame() {
                Ok(buffer) => break buffer,
                Err(error) => {
                    if error.kind() == ErrorKind::WouldBlock {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    } else {
                        return Err(format!("Capture error: {}", error));
                    }
                }
            }
        };

        let mut rgb_data = Vec::with_capacity(width * height * 3);
        for chunk in buffer.chunks_exact(4) {
            rgb_data.push(chunk[2]); // R
            rgb_data.push(chunk[1]); // G
            rgb_data.push(chunk[0]); // B
        }

        let mut jpeg_bytes = Vec::new();
        let encoder = JpegEncoder::new(&mut jpeg_bytes);
        encoder.write_image(&rgb_data, width as u32, height as u32, ExtendedColorType::Rgb8)
            .map_err(|e| format!("Failed to encode image to JPEG: {}", e))?;

        Ok(BASE64_STANDARD.encode(&jpeg_bytes))
    }).await.map_err(|e| format!("Task execution error: {}", e))?
}

// Maps normalized [0, 1000] coordinates to physical resolution considering scaling factor
fn map_coordinates(norm_x: f64, norm_y: f64, app_handle: &AppHandle) -> Result<(i32, i32), String> {
    let window = app_handle.get_webview_window("main")
        .ok_or_else(|| "Failed to get main webview window".to_string())?;
    
    let monitor = window.current_monitor()
        .map_err(|e| format!("Failed to get current monitor info: {}", e))?
        .ok_or_else(|| "No monitor info found".to_string())?;

    let size = monitor.size();
    let scale_factor = monitor.scale_factor();

    // Map [0, 1000] to actual display boundary
    let target_x = ((norm_x / 1000.0) * size.width as f64) * scale_factor;
    let target_y = ((norm_y / 1000.0) * size.height as f64) * scale_factor;

    Ok((target_x as i32, target_y as i32))
}

// Safe wrapper helper to press keys and guarantee they release even under errors
struct SafeKeyboardContext {
    enigo: Enigo,
    pressed_keys: Vec<Key>,
}

impl SafeKeyboardContext {
    fn new(settings: &Settings) -> Result<Self, String> {
        let enigo = Enigo::new(settings).map_err(|e| format!("Failed to init Enigo: {:?}", e))?;
        Ok(Self { enigo, pressed_keys: Vec::new() })
    }

    fn press_key(&mut self, key: Key) -> Result<(), String> {
        self.enigo.key(key, enigo::Direction::Press).map_err(|e| format!("Key press failed: {:?}", e))?;
        self.pressed_keys.push(key);
        Ok(())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        self.enigo.text(text).map_err(|e| format!("Type failed: {:?}", e))?;
        Ok(())
    }
}

impl Drop for SafeKeyboardContext {
    fn drop(&mut self) {
        // Release all pressed keys in reverse order to prevent stuck modifiers
        for key in self.pressed_keys.iter().rev() {
            let _ = self.enigo.key(*key, enigo::Direction::Release);
        }
    }
}

fn parse_key(key_str: &str) -> Result<Key, String> {
    match key_str.to_lowercase().as_str() {
        "ctrl" | "control" => Ok(Key::Control),
        "alt" => Ok(Key::Alt),
        "shift" => Ok(Key::Shift),
        "meta" | "win" | "command" => Ok(Key::Meta),
        "tab" => Ok(Key::Tab),
        "enter" | "return" => Ok(Key::Return),
        "escape" | "esc" => Ok(Key::Escape),
        "backspace" => Ok(Key::Backspace),
        "delete" | "del" => Ok(Key::Delete),
        "space" => Ok(Key::Space),
        c if c.len() == 1 => {
            let ch = c.chars().next().unwrap();
            Ok(Key::Unicode(ch))
        },
        _ => Err(format!("Unrecognized key mapping name: {}", key_str)),
    }
}

// Executes mapped OS operations inside Rust backend
#[tauri::command]
pub async fn execute_action(app: AppHandle, action: String, params: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let settings = Settings::default();
        let mut enigo = Enigo::new(&settings).map_err(|e| format!("Failed to init Enigo: {:?}", e))?;

        match action.as_str() {
            "click" | "double_click" | "right_click" => {
                let norm_x = params["x"].as_f64().ok_or("Missing x coordinate")?;
                let norm_y = params["y"].as_f64().ok_or("Missing y coordinate")?;
                let (x, y) = map_coordinates(norm_x, norm_y, &app)?;

                enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| format!("Mouse move failed: {:?}", e))?;
                std::thread::sleep(std::time::Duration::from_millis(150));

                let button = if action == "right_click" { enigo::Button::Right } else { enigo::Button::Left };
                let clicks = if action == "double_click" { 2 } else { 1 };

                for _ in 0..clicks {
                    enigo.button(button, enigo::Direction::Click).map_err(|e| format!("Mouse click failed: {:?}", e))?;
                    if clicks > 1 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            },
            "drag" => {
                let norm_x1 = params["x1"].as_f64().ok_or("Missing x1 coordinate")?;
                let norm_y1 = params["y1"].as_f64().ok_or("Missing y1 coordinate")?;
                let norm_x2 = params["x2"].as_f64().ok_or("Missing x2 coordinate")?;
                let norm_y2 = params["y2"].as_f64().ok_or("Missing y2 coordinate")?;

                let (x1, y1) = map_coordinates(norm_x1, norm_y1, &app)?;
                let (x2, y2) = map_coordinates(norm_x2, norm_y2, &app)?;

                enigo.move_mouse(x1, y1, Coordinate::Abs).map_err(|e| format!("Mouse move to start failed: {:?}", e))?;
                std::thread::sleep(std::time::Duration::from_millis(100));
                enigo.button(enigo::Button::Left, enigo::Direction::Press).map_err(|e| format!("Mouse press failed: {:?}", e))?;
                std::thread::sleep(std::time::Duration::from_millis(150));
                enigo.move_mouse(x2, y2, Coordinate::Abs).map_err(|e| format!("Mouse drag failed: {:?}", e))?;
                std::thread::sleep(std::time::Duration::from_millis(150));
                enigo.button(enigo::Button::Left, enigo::Direction::Release).map_err(|e| format!("Mouse release failed: {:?}", e))?;
            },
            "type" => {
                let text = params["text"].as_str().ok_or("Missing text parameter")?;
                let mut kb = SafeKeyboardContext::new(&settings)?;
                kb.type_text(text)?;
            },
            "hotkey" => {
                let keys_arr = params["keys"].as_array().ok_or("Missing keys list array")?;
                let mut kb = SafeKeyboardContext::new(&settings)?;
                for val in keys_arr {
                    let k_str = val.as_str().ok_or("Invalid key string")?;
                    let k = parse_key(k_str)?;
                    kb.press_key(k)?;
                }
            },
            "scroll" => {
                let direction = params["direction"].as_str().ok_or("Missing scroll direction")?;
                let amount = params["amount"].as_i64().ok_or("Missing scroll amount")? as i32;
                let axis = enigo::Axis::Vertical;
                let steps = if direction == "down" { -amount } else { amount };
                enigo.scroll(steps, axis).map_err(|e| format!("Scroll failed: {:?}", e))?;
            },
            _ => return Err(format!("Unsupported action type: {}", action)),
        }
        Ok(())
    }).await.map_err(|e| format!("Task execution error: {}", e))?
}

// Parses actions from strings, returning name and json value representation
fn parse_action_string(action_line: &str) -> Option<(String, Value)> {
    let clean = action_line.trim();
    if !clean.starts_with("Action:") {
        return None;
    }
    let body = clean.strip_prefix("Action:")?.trim();
    
    // Parse stop()
    if body == "stop()" {
        return Some(("stop".to_string(), serde_json::json!({})));
    }
    
    // Pattern matches: name(params)
    let open_idx = body.find('(')?;
    let close_idx = body.rfind(')')?;
    let name = body[..open_idx].trim().to_string();
    let params_str = &body[open_idx + 1..close_idx];
    
    let mut map = serde_json::Map::new();
    for pair in params_str.split(',') {
        if pair.trim().is_empty() { continue; }
        let mut kv = pair.split('=');
        let k = kv.next()?.trim();
        let v_str = kv.next()?.trim();
        
        if v_str.starts_with('"') && v_str.ends_with('"') {
            map.insert(k.to_string(), Value::String(v_str[1..v_str.len()-1].to_string()));
        } else if v_str.starts_with('[') && v_str.ends_with(']') {
            let inner = &v_str[1..v_str.len()-1];
            let list: Vec<Value> = inner.split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .map(Value::String)
                .collect();
            map.insert(k.to_string(), Value::Array(list));
        } else if let Ok(num) = v_str.parse::<f64>() {
            map.insert(k.to_string(), Value::Number(serde_json::Number::from_f64(num)?));
        } else {
            map.insert(k.to_string(), Value::String(v_str.to_string()));
        }
    }
    
    Some((name, Value::Object(map)))
}

// Update routing profile config settings
#[tauri::command]
pub async fn update_routing_settings(settings: ProviderSettings) -> Result<(), String> {
    let mut state = STATE.lock().await;
    state.settings = settings;
    Ok(())
}

#[tauri::command]
pub async fn trigger_panic(app: AppHandle) -> Result<(), String> {
    let state_clone = STATE.clone();
    let mut state = state_clone.lock().await;
    
    // 1. Forcefully cancel background worker loops
    if let Some(token) = state.cancel_token.take() {
        token.cancel();
    }
    state.is_running = false;

    // 2. Sequentially release keyboard modifiers to prevent frozen inputs
    tokio::task::spawn_blocking(|| {
        let settings = Settings::default();
        if let Ok(mut enigo) = Enigo::new(&settings) {
            let _ = enigo.key(Key::Shift, enigo::Direction::Release);
            let _ = enigo.key(Key::Control, enigo::Direction::Release);
            let _ = enigo.key(Key::Alt, enigo::Direction::Release);
            let _ = enigo.key(Key::Meta, enigo::Direction::Release);
        }
    }).await.map_err(|e| format!("Panic cleanup thread failed: {}", e))?;

    // 3. Emit notification warning back to the UI layout
    let _ = app.emit("agent-step", AgentStepEvent {
        status: "aborted".into(),
        thought: Some("EMERGENCY INTERRUPT ACTIVE: Loop aborted and cursor manual control restored!".into()),
        action: Some("panic()".into()),
        mcp_tool_call: None,
    });

    Ok(())
}

#[tauri::command]
pub async fn start_agent_loop(app: AppHandle, instruction: String) -> Result<(), String> {

    if is_admin_or_root() {
        return Err("Execution Rejected: Hiro cannot be run under elevated administrator or root privileges.".into());
    }


    let state_clone = STATE.clone();
    let token = CancellationToken::new();
    let token_clone = token.clone();
    {
        let mut state = state_clone.lock().await;
        if state.is_running {
            return Err("Agent loop is already running".into());
        }
        state.is_running = true;
        state.cancel_token = Some(token);
        state.history.clear(); // Reset history turns for the new instruction session
    }

    tokio::spawn(async move {
        let _ = app.emit("agent-step", AgentStepEvent {
            status: "started".into(),
            thought: Some("Analyzing desktop state...".into()),
            action: None,
            mcp_tool_call: None,
        });

        // 6-step loop lifecycle simulation
        for step in 1..=6 {
            if token_clone.is_cancelled() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if token_clone.is_cancelled() {
                break;
            }


            // 1. Capture primary display screen frame buffer (T0)
            let mut screenshot_base64 = "".to_string();
            if let Ok(data) = capture_screen().await {
                screenshot_base64 = data;
            }

            // 2. Perform Visual Context Memory Culling on previous history states
            {
                let mut state = state_clone.lock().await;
                let history_len = state.history.len();
                for i in 0..history_len {
                    let steps_back = history_len - i;
                    if steps_back >= 4 {
                        // Episodic Visual Stripping: strip images entirely for T-4 and older
                        state.history[i].screenshot = None;
                    } else if steps_back >= 1 {
                        // Immediate History Downsampling: compress screenshots for T-1 to T-3
                        if let Some(ref img_src) = state.history[i].screenshot {
                            if img_src.len() > 100000 { // Downsample only if not already resized
                                if let Ok(downsampled) = downsample_screenshot(img_src) {
                                    state.history[i].screenshot = Some(downsampled);
                                }
                            }
                        }
                    }
                }
            }

            // Simulating execution trace with both Hybrid MCP and standard coordinates
            let raw_vlm_text = if step == 1 {
                // Let's execute an MCP tool directly instead of coordinate mouse warping
                "Thought: The user wants to read a file. I can do this using the MCP read_file tool.\nAction: call_tool(name=\"read_file\", path=\"hiro_audit.jsonl\")".to_string()
            } else if step < 6 {
                format!("Thought: Performing coordinate mouse action to locate UI components.\nAction: click(x=400, y={})", step * 100)
            } else {
                "Thought: Task complete.\nAction: stop()".to_string()
            };

            let mut current_thought = "".to_string();
            let mut parsed_action = None;

            for line in raw_vlm_text.lines() {
                if line.trim().starts_with("Thought:") {
                    current_thought = line.trim().strip_prefix("Thought:").unwrap().trim().to_string();
                } else if line.trim().starts_with("Action:") {
                    if let Some((act_name, act_val)) = parse_action_string(line) {
                        parsed_action = Some((act_name, act_val, line.trim().to_string()));
                    }
                }
            }

            // Write to the append-only audit JSONL file
            let hash_placeholder = format!("sha256_step_{}", step);
            let _ = write_audit_log(AuditLogEntry {
                timestamp: chrono::Utc::now().to_rfc3339(),
                instruction: instruction.clone(),
                screenshot_hash: hash_placeholder,
                thought: current_thought.clone(),
                action: parsed_action.as_ref().map(|p| p.2.clone()).unwrap_or_else(|| "none".to_string()),
            });

            // Handle the parsed action routing
            if let Some((ref act_name, ref act_val, ref raw_act)) = parsed_action {
                if act_name == "call_tool" {
                    let tool_name = act_val["name"].as_str().unwrap_or("");
                    let _ = app.emit("agent-step", AgentStepEvent {
                        status: "running".into(),
                        thought: Some(current_thought.clone()),
                        action: Some(raw_act.clone()),
                        mcp_tool_call: Some(format!("Executing MCP tool call: {}...", tool_name)),
                    });
                    
                    // Dispatch to direct local system MCP handler
                    let _mcp_res = execute_mcp_tool(tool_name, act_val);
                    std::thread::sleep(std::time::Duration::from_millis(300));
                } else if act_name == "stop" {
                    let _ = app.emit("agent-step", AgentStepEvent {
                        status: "completed".into(),
                        thought: Some(current_thought.clone()),
                        action: Some(raw_act.clone()),
                        mcp_tool_call: None,
                    });
                    break;
                } else {
                    let _ = app.emit("agent-step", AgentStepEvent {
                        status: "running".into(),
                        thought: Some(current_thought.clone()),
                        action: Some(raw_act.clone()),
                        mcp_tool_call: None,
                    });
                    // Run native OS coordinate warping or keyboards events
                    let _ = execute_action(app.clone(), act_name.clone(), act_val.clone()).await;
                }

                // Push current turn state to visual memory history stack
                {
                    let mut state = state_clone.lock().await;
                    state.history.push(HistoricalTurn {
                        step,
                        action: raw_act.clone(),
                        thought: current_thought.clone(),
                        screenshot: Some(screenshot_base64),
                    });
                }
            }

            // Cooldown delay
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        let mut state = state_clone.lock().await;
        state.is_running = false;
    });

    Ok(())
}
