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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub timestamp: String,
    pub instruction: String,
    pub screenshot_hash: String,
    pub thought: String,
    pub action: String,
}

// Global active loop state helper
struct ActiveState {
    is_running: bool,
}

lazy_static::lazy_static! {
    static ref STATE: Arc<Mutex<ActiveState>> = Arc::new(Mutex::new(ActiveState { is_running: false }));
}

// Check non-privileged safety guard
fn is_admin_or_root() -> bool {
    is_elevated()
}

// Helper to write to JSONL Audit file
fn write_audit_log(entry: AuditLogEntry) -> std::io::Result<()> {
    let serialized = serde_json::to_string(&entry)? + "\n";
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open("hiro_audit.jsonl")?;
    file.write_all(serialized.as_bytes())?;
    Ok(())
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
                // When kb leaves scope, SafeKeyboardContext Drop handler automatically releases key modifiers in safety
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
            // Simple array parser for hotkeys
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

#[tauri::command]
pub async fn start_agent_loop(app: AppHandle, instruction: String) -> Result<(), String> {
    if is_admin_or_root() {
        return Err("Execution Rejected: Hiro cannot be run under elevated administrator or root privileges.".into());
    }

    let state_clone = STATE.clone();
    {
        let mut state = state_clone.lock().await;
        if state.is_running {
            return Err("Agent loop is already running".into());
        }
        state.is_running = true;
    }

    tokio::spawn(async move {
        let _ = app.emit("agent-step", AgentStepEvent {
            status: "started".into(),
            thought: Some("Analyzing desktop state...".into()),
            action: None,
        });

        // Simulating the feedback loops
        for step in 1..=6 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

            let mut _screenshot_base64 = "".to_string();
            if let Ok(data) = capture_screen().await {
                _screenshot_base64 = data;
            }


            // Simulating parsing of VLM text tokens stream
            let raw_vlm_text = if step < 6 {
                format!("Thought: Locating target elements on screen to fulfill task.\nAction: click(x=500, y={})", step * 100)
            } else {
                "Thought: Target task completed successfully.\nAction: stop()".to_string()
            };

            // Parse thoughts & actions
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

            // Log entry into JSONL audit log
            let hash_placeholder = format!("sha256_{}", step);
            let _ = write_audit_log(AuditLogEntry {
                timestamp: chrono::Utc::now().to_rfc3339(),
                instruction: instruction.clone(),
                screenshot_hash: hash_placeholder,
                thought: current_thought.clone(),
                action: parsed_action.as_ref().map(|p| p.2.clone()).unwrap_or_else(|| "none".to_string()),
            });

            // Perform native execution unless it's stop
            if let Some((ref act_name, ref act_val, ref raw_act)) = parsed_action {
                if act_name == "stop" {
                    let _ = app.emit("agent-step", AgentStepEvent {
                        status: "completed".into(),
                        thought: Some(current_thought),
                        action: Some(raw_act.clone()),
                    });
                    break;
                } else {
                    let _ = app.emit("agent-step", AgentStepEvent {
                        status: "running".into(),
                        thought: Some(current_thought.clone()),
                        action: Some(raw_act.clone()),
                    });
                    // Run native execution command
                    let _ = execute_action(app.clone(), act_name.clone(), act_val.clone()).await;
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
