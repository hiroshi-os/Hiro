# Hiro: Lightweight Visual-Agent Desktop Automation Engine

Hiro is a high-performance, lightweight visual-agent desktop automation platform, engineered in **Rust + Tauri v2**. It provides a native, secure, and resource-efficient desktop driver designed to execute visual agentic commands through pixel-level screenshots and native hardware input simulation.

---

## Architectural Comparison

| Engine Component | Baseline Electron Agent Stacks | Hiro Engine Implementation | Architectural Advantage |
| --- | --- | --- | --- |
| **Runtime Wrapper** | Electron (Chromium + Node) | **Tauri v2 (Rust + Webview2)** | Massive reduction in memory baseline and idling CPU overhead. |
| **Execution Loop** | Python-bridged subprocess scripts | **Async Native Tokio Worker Threads** | Real-time task interception with zero process-spawning delay. |
| **Context Safety** | Relies on standard loop breaks | **CancellationToken + `Drop` Trait Enforcer** | Zero risk of keyboard lockups; hardware state auto-clears on panics. |
| **Visual Memory** | Shifts full payloads to context window | **Adaptive $T_0 \to T_{-3}$ Downsampling Matrix** | Highly optimized token payloads; compatible with local VLM constraints. |

---

## Key Features

* **Coordinate Space Normalization & High-DPI Scaling**: Automatically maps standard normalized `[0, 1000]` coordinates outputted by visual models into the active monitor's physical boundaries based on high-DPI scaling factors.
* **Hybrid MCP Tool Execution**: Automatically intercepts text-based instructions and routes them through direct Model Context Protocol tool calls (like reading/writing files or listing directories) instead of running slow GUI macro loops.
* **Adaptive Visual Memory Tiering**:
  * **$T_0$ (Active turn)**: Maintained at full resolution to guarantee click coordinate accuracy.
  * **$T_{-1}$ to $T_{-3}$ (Immediate history)**: Resized to 800px width at 60% quality JPEG compression.
  * **$\le T_{-4}$ (Decayed history)**: Stripped of raw images entirely, replaced with lightweight text summary logs.
* **Global Hardware Panic Button (`Shift + ESC`)**: Instantly aborts the active Tokio execution thread, calls the keyboard `Drop` enforcer to release all held modifier keys (`Shift`, `Ctrl`, `Alt`), and yields control back to human input.
* **Dynamic Provider Routing**: Allows on-the-fly switching between local self-hosted endpoints (Ollama/vLLM) and cloud VLM APIs.
* **Persistent Audit Trails**: Generates append-only cryptographic log records in `hiro_audit.jsonl`.

---

## Getting Started

### Development
1. Clone the repository and install dependencies:
   ```bash
   bun install
   ```
2. Launch the developer build (starts Vite dev server and native Tauri app):
   ```bash
   bun run tauri dev
   ```

### Production Build
Compile a highly optimized native release executable:
```bash
bun run tauri build --no-bundle
```
The compiled output is generated as a standalone binary at `src-tauri/target/release/hiro.exe`.
