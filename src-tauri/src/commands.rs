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
use enigo::{Enigo, Keyboard, Settings, Key};
use is_elevated::is_elevated;

use crate::grounding;

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

// Coordinate Translation implementation within the native hardware injection node.
// Handles both coordinate-based (Enigo) and template-grounded (rustautogui) actions.
pub fn execute_native_action(action: ParsedAction, monitor_width: u32, monitor_height: u32, scale_factor: f64) {
    match action {
        // ─── Coordinate-based actions (VLM start_box output, Enigo driver) ───
        ParsedAction::Click { x, y } => {
            let physical_x = ((x as f64 / 1000.0) * monitor_width as f64 * scale_factor) as u32;
            let physical_y = ((y as f64 / 1000.0) * monitor_height as f64 * scale_factor) as u32;
            let _ = grounding::click_at(physical_x, physical_y);
        },
        ParsedAction::DoubleFloat { x, y } => {
            let physical_x = ((x as f64 / 1000.0) * monitor_width as f64 * scale_factor) as u32;
            let physical_y = ((y as f64 / 1000.0) * monitor_height as f64 * scale_factor) as u32;
            let _ = grounding::double_click_at(physical_x, physical_y);
        },
        ParsedAction::RightClick { x, y } => {
            let physical_x = ((x as f64 / 1000.0) * monitor_width as f64 * scale_factor) as u32;
            let physical_y = ((y as f64 / 1000.0) * monitor_height as f64 * scale_factor) as u32;
            let _ = grounding::right_click_at(physical_x, physical_y);
        },
        ParsedAction::Drag { x1, y1, x2, y2 } => {
            let px1 = ((x1 as f64 / 1000.0) * monitor_width as f64 * scale_factor) as u32;
            let py1 = ((y1 as f64 / 1000.0) * monitor_height as f64 * scale_factor) as u32;
            let px2 = ((x2 as f64 / 1000.0) * monitor_width as f64 * scale_factor) as u32;
            let py2 = ((y2 as f64 / 1000.0) * monitor_height as f64 * scale_factor) as u32;
            let _ = grounding::click_at(px1, py1);
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = grounding::drag_to(px2, py2, 0.3);
        },

        // ─── Template-grounded actions (rustautogui deterministic matching) ───
        ParsedAction::ClickTarget { target } => {
            let path = resolve_template_path(&target);
            match grounding::find_and_click_file(&path, 0.90, None) {
                Ok(Some((x, y))) => {
                    eprintln!("[grounding] ClickTarget '{}' matched at ({}, {})", target, x, y);
                },
                Ok(None) => {
                    eprintln!("[grounding] ClickTarget '{}' not found on screen", target);
                },
                Err(e) => {
                    eprintln!("[grounding] ClickTarget '{}' error: {}", target, e);
                },
            }
        },
        ParsedAction::DoubleClickTarget { target } => {
            let path = resolve_template_path(&target);
            if let Ok(Some((x, y))) = grounding::find_template_from_file(&path, 0.90, None) {
                let _ = grounding::double_click_at(x, y);
            }
        },
        ParsedAction::RightClickTarget { target } => {
            let path = resolve_template_path(&target);
            if let Ok(Some((x, y))) = grounding::find_template_from_file(&path, 0.90, None) {
                let _ = grounding::right_click_at(x, y);
            }
        },


        // ─── Common actions (routed through grounding native drivers) ───
        ParsedAction::Type { content } => {
            let _ = grounding::type_text(&content);
        },
        ParsedAction::Scroll { direction } => {
            let _ = grounding::scroll(&direction);
        },
        ParsedAction::Hotkey { key } => {
            // Parse multi-key combos like "ctrl+shift+t"
            let parts: Vec<&str> = key.split('+').collect();
            match parts.len() {
                1 => { let _ = grounding::key_press(parts[0]); },
                2 => { let _ = grounding::hotkey(parts[0], parts[1], None); },
                3 => { let _ = grounding::hotkey(parts[0], parts[1], Some(parts[2])); },
                _ => { eprintln!("[grounding] Unsupported hotkey combo: {}", key); }
            }
        },
        _ => {}
    }
}

/// Resolve a template alias to an absolute file path in the assets directory.
/// Templates are stored in `src-tauri/assets/templates/<name>.png`.
fn resolve_template_path(alias: &str) -> String {
    let template_path = format!("assets/templates/{}", alias);
    // If path doesn't have an extension, try .png
    if std::path::Path::new(&template_path).extension().is_some() {
        template_path
    } else {
        format!("{}.png", template_path)
    }
}


use regex::Regex;

lazy_static::lazy_static! {
    // Coordinate-based patterns (start_box)
    static ref CLICK_RE: Regex = Regex::new(r"click\(start_box='\((\d+),(\d+)\)'\)").unwrap();
    static ref DOUBLE_CLICK_RE: Regex = Regex::new(r"left_double\(start_box='\((\d+),(\d+)\)'\)").unwrap();
    static ref RIGHT_CLICK_RE: Regex = Regex::new(r"right_single\(start_box='\((\d+),(\d+)\)'\)").unwrap();
    static ref DRAG_RE: Regex = Regex::new(r"drag\(start_box='\((\d+),(\d+)\)',\s*end_box='\((\d+),(\d+)\)'\)").unwrap();
    // Template-grounded patterns (target='alias')
    static ref CLICK_TARGET_RE: Regex = Regex::new(r"click\(target='(.*?)'\)").unwrap();
    static ref DOUBLE_CLICK_TARGET_RE: Regex = Regex::new(r"left_double\(target='(.*?)'\)").unwrap();
    static ref RIGHT_CLICK_TARGET_RE: Regex = Regex::new(r"right_single\(target='(.*?)'\)").unwrap();
    // Common patterns
    static ref TYPE_RE: Regex = Regex::new(r"type\(content='(.*?)'\)").unwrap();
    static ref SCROLL_RE: Regex = Regex::new(r"scroll\(direction='(up|down|left|right)'\)").unwrap();
    static ref HOTKEY_RE: Regex = Regex::new(r"hotkey\(key='(.*?)'\)").unwrap();
    static ref FINISHED_RE: Regex = Regex::new(r"finished\(\)").unwrap();
    static ref CALL_TOOL_RE: Regex = Regex::new(r"call_tool\(name='(.*?)'(?:,\s*(.*?))?\)").unwrap();
}

#[derive(Debug, Clone)]
pub enum ParsedAction {
    // Coordinate-based (VLM start_box output, 0–1000 grid)
    Click { x: u32, y: u32 },
    DoubleFloat { x: u32, y: u32 },
    RightClick { x: u32, y: u32 },
    Drag { x1: u32, y1: u32, x2: u32, y2: u32 },
    // Template-grounded (deterministic visual search via rustautogui)
    ClickTarget { target: String },
    DoubleClickTarget { target: String },
    RightClickTarget { target: String },
    // Common
    Type { content: String },
    Scroll { direction: String },
    Hotkey { key: String },
    CallTool { name: String, args: Value },
    Stop,
}

pub fn parse_uitars_action(action_str: &str) -> Option<ParsedAction> {
    let clean_str = action_str.trim();

    if let Some(caps) = CLICK_RE.captures(clean_str) {
        let x = caps[1].parse::<u32>().ok()?;
        let y = caps[2].parse::<u32>().ok()?;
        return Some(ParsedAction::Click { x, y });
    }
    
    if let Some(caps) = DOUBLE_CLICK_RE.captures(clean_str) {
        let x = caps[1].parse::<u32>().ok()?;
        let y = caps[2].parse::<u32>().ok()?;
        return Some(ParsedAction::DoubleFloat { x, y });
    }

    if let Some(caps) = RIGHT_CLICK_RE.captures(clean_str) {
        let x = caps[1].parse::<u32>().ok()?;
        let y = caps[2].parse::<u32>().ok()?;
        return Some(ParsedAction::RightClick { x, y });
    }

    if let Some(caps) = DRAG_RE.captures(clean_str) {
        let x1 = caps[1].parse::<u32>().ok()?;
        let y1 = caps[2].parse::<u32>().ok()?;
        let x2 = caps[3].parse::<u32>().ok()?;
        let y2 = caps[4].parse::<u32>().ok()?;
        return Some(ParsedAction::Drag { x1, y1, x2, y2 });
    }

    if let Some(caps) = TYPE_RE.captures(clean_str) {
        return Some(ParsedAction::Type { content: caps[1].to_string() });
    }

    if let Some(caps) = SCROLL_RE.captures(clean_str) {
        return Some(ParsedAction::Scroll { direction: caps[1].to_string() });
    }

    if let Some(caps) = HOTKEY_RE.captures(clean_str) {
        return Some(ParsedAction::Hotkey { key: caps[1].to_string() });
    }

    // Template-grounded target patterns
    if let Some(caps) = CLICK_TARGET_RE.captures(clean_str) {
        return Some(ParsedAction::ClickTarget { target: caps[1].to_string() });
    }
    if let Some(caps) = DOUBLE_CLICK_TARGET_RE.captures(clean_str) {
        return Some(ParsedAction::DoubleClickTarget { target: caps[1].to_string() });
    }
    if let Some(caps) = RIGHT_CLICK_TARGET_RE.captures(clean_str) {
        return Some(ParsedAction::RightClickTarget { target: caps[1].to_string() });
    }

    if let Some(caps) = CALL_TOOL_RE.captures(clean_str) {
        let name = caps[1].to_string();
        let mut args = serde_json::json!({});
        if let Some(args_raw) = caps.get(2) {
            let args_str = args_raw.as_str().trim();
            // Basic parsing of tool args (e.g. path='file.log')
            let mut map = serde_json::Map::new();
            for pair in args_str.split(',') {
                let mut parts = pair.split('=');
                if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                    let key = k.trim().to_string();
                    let val = v.trim().trim_matches('\'').to_string();
                    map.insert(key, Value::String(val));
                }
            }
            args = Value::Object(map);
        }
        return Some(ParsedAction::CallTool { name, args });
    }

    if FINISHED_RE.is_match(clean_str) || clean_str.contains("finished()") || clean_str.contains("stop()") {
        return Some(ParsedAction::Stop);
    }

    None
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
pub async fn start_agent_loop(app: AppHandle, instruction: String, system_prompt: String) -> Result<(), String> {



    if is_admin_or_root() {
        return Err("Execution Rejected: Hiro cannot be run under elevated administrator or root privileges.".into());
    }


    let state_clone = STATE.clone();
    let token = CancellationToken::new();
    let token_clone = token.clone();
    let _ = system_prompt;

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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                std::thread::sleep(std::time::Duration::from_millis(150));
                if let Ok(data) = capture_screen().await {
                    screenshot_base64 = data;
                }
                let _ = window.show();
            } else {
                if let Ok(data) = capture_screen().await {
                    screenshot_base64 = data;
                }
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

            // Simulating execution trace conforming to start_box training coordinates
            let raw_vlm_text = if step == 1 {
                "Thought: Executing direct MCP write verification.\nAction: call_tool(name='write_file', path='src-tauri/hiro_audit.log', content='test')".to_string()
            } else if step < 6 {
                format!("Thought: Locating targeted interface element.\nAction: click(start_box='(400,{})')", step * 100)
            } else {
                "Thought: Operation accomplished.\nAction: finished()".to_string()
            };


            let mut current_thought = "".to_string();
            let mut parsed_action = None;
            let mut raw_act_line = "".to_string();

            for line in raw_vlm_text.lines() {
                if line.trim().starts_with("Thought:") {
                    current_thought = line.trim().strip_prefix("Thought:").unwrap().trim().to_string();
                } else if line.trim().starts_with("Action:") {
                    let action_part = line.trim().strip_prefix("Action:").unwrap().trim();
                    if let Some(parsed) = parse_uitars_action(action_part) {
                        parsed_action = Some(parsed);
                        raw_act_line = line.trim().to_string();
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
                action: raw_act_line.clone(),
            });

            // Handle the parsed action routing
            if let Some(act) = parsed_action {
                match act {
                    ParsedAction::CallTool { name, args } => {
                        let _ = app.emit("agent-step", AgentStepEvent {
                            status: "running".into(),
                            thought: Some(current_thought.clone()),
                            action: Some(raw_act_line.clone()),
                            mcp_tool_call: Some(format!("Executing MCP tool call: {}...", name)),
                        });
                        let _mcp_res = execute_mcp_tool(&name, &args);
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    },
                    ParsedAction::Stop => {
                        let _ = app.emit("agent-step", AgentStepEvent {
                            status: "completed".into(),
                            thought: Some(current_thought.clone()),
                            action: Some(raw_act_line.clone()),
                            mcp_tool_call: None,
                        });
                        break;
                    },
                    other_action => {
                        let _ = app.emit("agent-step", AgentStepEvent {
                            status: "running".into(),
                            thought: Some(current_thought.clone()),
                            action: Some(raw_act_line.clone()),
                            mcp_tool_call: None,
                        });
                        
                        // Execute native OS action (mapping 1000-based coordinates)
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(Some(monitor)) = window.current_monitor() {
                                let size = monitor.size();
                                let scale_factor = monitor.scale_factor();
                                execute_native_action(other_action, size.width, size.height, scale_factor);
                            }
                        }
                    }
                }

                // Push current turn state to visual memory history stack
                {
                    let mut state = state_clone.lock().await;
                    state.history.push(HistoricalTurn {
                        step,
                        action: raw_act_line.clone(),
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

