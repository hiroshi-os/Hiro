// grounding.rs — Hybrid Template Matching & Deterministic Grounding Layer
//
// This module wraps the `rustautogui` crate to provide:
//   1. Screen-level template matching using Segmented cross-correlation.
//   2. Region-constrained searches to exclude the Hiro window area (mirror trap elimination).
//   3. A template registry for pre-loaded icon assets keyed by alias strings.
//   4. Mouse movement and click execution through native OS drivers.
//
// NOTE: RustAutoGui contains raw Win32 handles (HDC, HBITMAP) which are !Send + !Sync.
// We create instances on the calling thread rather than storing in a global static.

use rustautogui::{RustAutoGui, MatchMode};
use std::path::Path;

/// Create a fresh RustAutoGui instance on the current thread.
fn new_gui() -> Result<RustAutoGui, String> {
    let mut gui = RustAutoGui::new(false)
        .map_err(|e| format!("Failed to initialize RustAutoGui: {}", e))?;
    gui.set_suppress_warnings(true);
    Ok(gui)
}

/// Register a template image from a file path and search the screen for it.
/// Returns the best match coordinates `(x, y)` if found above `precision` threshold.
///
/// * `file_path`   - Path to the PNG/JPEG template asset on disk.
/// * `precision`   - Minimum correlation threshold (0.0 – 1.0). Recommended: 0.90–0.95.
/// * `region`      - Optional `(x, y, width, height)` search constraint.
pub fn find_template_from_file(
    file_path: &str,
    precision: f32,
    region: Option<(u32, u32, u32, u32)>,
) -> Result<Option<(u32, u32)>, String> {
    if !Path::new(file_path).exists() {
        return Err(format!("Template file not found: {}", file_path));
    }

    let mut gui = new_gui()?;

    gui.prepare_template_from_file(
        file_path,
        region,
        MatchMode::Segmented,
    ).map_err(|e| format!("Failed to prepare template '{}': {}", file_path, e))?;

    let results = gui.find_image_on_screen(precision)
        .map_err(|e| format!("Template search failed for '{}': {}", file_path, e))?;

    match results {
        Some(locations) if !locations.is_empty() => {
            let (x, y, _confidence) = locations[0];
            Ok(Some((x, y)))
        },
        _ => Ok(None),
    }
}

/// Find a template on screen and click on it.
/// Returns the matched coordinates or None if template was not found.
pub fn find_and_click_file(
    file_path: &str,
    precision: f32,
    region: Option<(u32, u32, u32, u32)>,
) -> Result<Option<(u32, u32)>, String> {
    if !Path::new(file_path).exists() {
        return Err(format!("Template file not found: {}", file_path));
    }

    let mut gui = new_gui()?;

    gui.prepare_template_from_file(
        file_path,
        region,
        MatchMode::Segmented,
    ).map_err(|e| format!("Failed to prepare template '{}': {}", file_path, e))?;

    let results = gui.find_image_on_screen_and_move_mouse(precision, 0.1)
        .map_err(|e| format!("Template find+move failed for '{}': {}", file_path, e))?;

    match results {
        Some(locations) if !locations.is_empty() => {
            let (x, y, _confidence) = locations[0];
            gui.left_click()
                .map_err(|e| format!("Click after find failed: {}", e))?;
            Ok(Some((x, y)))
        },
        _ => Ok(None),
    }
}

/// Click at a specific absolute screen coordinate using RustAutoGui native driver.
pub fn click_at(x: u32, y: u32) -> Result<(), String> {
    let gui = new_gui()?;
    gui.move_mouse_to_pos(x, y, 0.1)
        .map_err(|e| format!("Mouse move failed: {}", e))?;
    gui.left_click()
        .map_err(|e| format!("Left click failed: {}", e))?;
    Ok(())
}

/// Double-click at a specific absolute screen coordinate.
pub fn double_click_at(x: u32, y: u32) -> Result<(), String> {
    let gui = new_gui()?;
    gui.move_mouse_to_pos(x, y, 0.1)
        .map_err(|e| format!("Mouse move failed: {}", e))?;
    gui.double_click()
        .map_err(|e| format!("Double click failed: {}", e))?;
    Ok(())
}

/// Right-click at a specific absolute screen coordinate.
pub fn right_click_at(x: u32, y: u32) -> Result<(), String> {
    let gui = new_gui()?;
    gui.move_mouse_to_pos(x, y, 0.1)
        .map_err(|e| format!("Mouse move failed: {}", e))?;
    gui.right_click()
        .map_err(|e| format!("Right click failed: {}", e))?;
    Ok(())
}

/// Get the current screen dimensions from RustAutoGui.
pub fn get_screen_size() -> Result<(u32, u32), String> {
    let mut gui = new_gui()?;
    let (w, h) = gui.get_screen_size();
    Ok((w as u32, h as u32))
}

/// Scroll in a given direction.
pub fn scroll(direction: &str) -> Result<(), String> {
    let gui = new_gui()?;
    match direction {
        "up" => gui.scroll_up(3).map_err(|e| format!("Scroll up failed: {}", e)),
        "down" => gui.scroll_down(3).map_err(|e| format!("Scroll down failed: {}", e)),
        "left" => gui.scroll_left(3).map_err(|e| format!("Scroll left failed: {}", e)),
        "right" => gui.scroll_right(3).map_err(|e| format!("Scroll right failed: {}", e)),
        _ => Err(format!("Unknown scroll direction: {}", direction)),
    }
}

/// Type a string using keyboard input.
pub fn type_text(text: &str) -> Result<(), String> {
    let mut gui = new_gui()?;
    let _ = gui.left_click();
    std::thread::sleep(std::time::Duration::from_millis(150));
    gui.keyboard_input(text)
        .map_err(|e| format!("Keyboard input failed: {}", e))
}

/// Press a keyboard command (e.g. "backspace", "enter", "tab").
pub fn key_press(key: &str) -> Result<(), String> {
    let gui = new_gui()?;
    gui.keyboard_command(key)
        .map_err(|e| format!("Keyboard command failed: {}", e))
}

/// Execute a multi-key press (e.g. Ctrl+Shift+T).
pub fn hotkey(key1: &str, key2: &str, key3: Option<&str>) -> Result<(), String> {
    let gui = new_gui()?;
    gui.keyboard_multi_key(key1, key2, key3)
        .map_err(|e| format!("Multi-key press failed: {}", e))
}

/// Drag mouse from current position to target coordinates.
pub fn drag_to(x: u32, y: u32, duration: f64) -> Result<(), String> {
    let gui = new_gui()?;
    gui.drag_mouse_to_pos(x, y, duration as f32)
        .map_err(|e| format!("Drag failed: {}", e))
}
