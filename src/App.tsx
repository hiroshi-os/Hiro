import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

interface Message {
  id: string;
  sender: 'user' | 'hiro';
  text: string;
  screenshot?: string;
  thought?: string;
  action?: string;
  status?: string;
}

interface AgentStepPayload {
  status: string;
  thought: string | null;
  action: string | null;
  mcp_tool_call: string | null;
}

export default function App() {
  const [instruction, setInstruction] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'hiro',
      text: 'Ready. Type a task and I will execute it on your desktop.',
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showSettings, setShowSettings] = useState(false);
  const [providerType, setProviderType] = useState('local');
  const [endpoint, setEndpoint] = useState('http://localhost:11434');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('minimax-m3:cloud');
  const [opacity, setOpacity] = useState(95);
  const [maxSteps, setMaxSteps] = useState(15);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Content protection + window setup on mount
  useEffect(() => {
    const setup = async () => {
      const win = getCurrentWebviewWindow();
      await win.setContentProtected(true);
    };
    setup();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const unlisten = listen<AgentStepPayload>('agent-step', (event) => {
      const payload = event.payload;

      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        if (lastMessage && lastMessage.sender === 'hiro' && lastMessage.status !== 'completed' && lastMessage.status !== 'aborted') {
          return [
            ...prev.slice(0, -1),
            {
              ...lastMessage,
              text: payload.mcp_tool_call || payload.thought || lastMessage.text,
              thought: payload.thought || undefined,
              action: payload.action || undefined,
              status: payload.status,
            },
          ];
        } else {
          return [
            ...prev,
            {
              id: Math.random().toString(),
              sender: 'hiro',
              text: payload.mcp_tool_call || payload.thought || 'Processing...',
              thought: payload.thought || undefined,
              action: payload.action || undefined,
              status: payload.status,
            },
          ];
        }
      });

      if (payload.status === 'completed' || payload.status === 'aborted') {
        setIsProcessing(false);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instruction.trim() || isProcessing) return;

    setErrorMsg(null);
    const userMessageId = Math.random().toString();
    const userText = instruction;
    setInstruction('');

    let screenshotBase64 = '';
    try {
      screenshotBase64 = await invoke<string>('capture_screen');
    } catch (err) {
      console.error('Failed to capture screen snapshot:', err);
    }

    const systemPrompt = `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Format
Thought: ...
Action: click(start_box='(x,y)') or click(target='element_name') or other actions from the Action Space below.

## Action Space

### Coordinate-Based Actions (use when you can identify exact position)
click(start_box='(x,y)')
left_double(start_box='(x,y)')
right_single(start_box='(x,y)')
drag(start_box='(x1,y1)', end_box='(x2,y2)')

### Template-Grounded Actions (use when a known UI element/icon can be matched visually)
click(target='element_name.png')
left_double(target='element_name.png')
right_single(target='element_name.png')

### Input Actions
type(content='TEXT_STRING')
scroll(direction='up' | 'down' | 'left' | 'right')
hotkey(key='KEY_COMBINATION')

### Control
finished()
call_user()`;

    setMessages((prev) => [
      ...prev,
      {
        id: userMessageId,
        sender: 'user',
        text: userText,
        screenshot: screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : undefined,
      },
    ]);

    setIsProcessing(true);

    try {
      await invoke('start_agent_loop', { instruction: userText, systemPrompt });
    } catch (err) {
      setErrorMsg(String(err));
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: 'hiro',
          text: `Error: ${err}`,
        },
      ]);
      setIsProcessing(false);
    }
  };

  const saveSettings = async () => {
    try {
      await invoke('update_routing_settings', {
        settings: {
          provider_type: providerType,
          endpoint: endpoint,
          api_key: apiKey || null,
          model: model,
        }
      });
      setShowSettings(false);
    } catch (err) {
      alert(`Failed to save settings: ${err}`);
    }
  };

  const triggerManualPanic = async () => {
    try {
      await invoke('trigger_panic');
    } catch (err) {
      console.error('Panic trigger failed:', err);
    }
  };

  const clearSession = async () => {
    try {
      await invoke('clear_session');
      setMessages([{
        id: 'reset-' + Date.now(),
        sender: 'hiro',
        text: 'Session cleared. Ready for a new task.',
      }]);
      setIsProcessing(false);
      setErrorMsg(null);
    } catch (err) {
      console.error('Failed to clear session:', err);
    }
  };

  // Custom window controls
  const minimizeWindow = () => getCurrentWebviewWindow().minimize();
  const toggleMaximize = async () => {
    const win = getCurrentWebviewWindow();
    const maximized = await win.isMaximized();
    if (maximized) {
      await win.unmaximize();
    } else {
      await win.maximize();
    }
  };
  const closeWindow = () => getCurrentWebviewWindow().close();

  const handleMouseDown = async (e: React.MouseEvent) => {
    if (e.button === 0 && !(e.target as HTMLElement).closest('button')) {
      try {
        await getCurrentWebviewWindow().startDragging();
      } catch (err) {
        console.error('Failed dragging window:', err);
      }
    }
  };

  const c = theme === 'dark' ? darkColors : lightColors;
  const bg = theme === 'dark'
    ? `rgba(12, 12, 12, ${opacity / 100})`
    : `rgba(255, 255, 255, ${opacity / 100})`;

  return (
    <div style={{ ...s.shell, background: bg, color: c.text, borderColor: c.border }}>

      {/* ─── Custom Titlebar ─── */}
      <div 
        onMouseDown={handleMouseDown}
        style={{ ...s.titlebar, borderBottom: `1px solid ${c.border}` }}
      >
        <div style={s.titleLeft}>
          <div style={{ ...s.dot, background: isProcessing ? '#22c55e' : c.accent, boxShadow: isProcessing ? '0 0 8px #22c55e88' : 'none' }} />
          <span style={{ ...s.titleText, color: c.text }}>Hiro</span>
          <span style={{ ...s.titleSub, color: c.sub }}>v0.1</span>
        </div>
        <div style={s.titleRight}>
          <button onClick={minimizeWindow} style={{ ...s.winBtn, color: c.sub }} title="Minimize">
            <svg width="10" height="10" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button onClick={toggleMaximize} style={{ ...s.winBtn, color: c.sub }} title="Maximize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          </button>
          <button onClick={closeWindow} style={{ ...s.winBtnClose, color: c.sub }} title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>

      {/* ─── Toolbar ─── */}
      <div style={{ ...s.toolbar, borderBottom: `1px solid ${c.border}`, background: theme === 'dark' ? 'rgba(18,18,18,0.6)' : 'rgba(244,244,245,0.6)' }}>
        <div style={s.toolGroup}>
          <button style={{ ...s.toolBtn, color: c.text, background: c.btnBg, border: `1px solid ${c.border}` }} onClick={() => setShowSettings(!showSettings)}>
            ⚙ Settings
          </button>
          <button style={{ ...s.toolBtn, color: c.text, background: c.btnBg, border: `1px solid ${c.border}` }} onClick={clearSession}>
            ↺ New
          </button>
          <button style={{ ...s.toolBtn, color: c.text, background: c.btnBg, border: `1px solid ${c.border}` }} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀' : '◑'}
          </button>
        </div>
        {isProcessing && (
          <button style={s.panicBtn} onClick={triggerManualPanic}>
            ■ Stop
          </button>
        )}
      </div>

      {/* ─── Error Banner ─── */}
      {errorMsg && (
        <div style={s.errorBanner}>
          <strong>Error:</strong> {errorMsg}
        </div>
      )}

      {/* ─── Settings Panel ─── */}
      {showSettings && (
        <div style={{ ...s.settingsPanel, background: theme === 'dark' ? 'rgba(18,18,18,0.95)' : 'rgba(244,244,245,0.95)', borderBottom: `1px solid ${c.border}` }}>
          <div style={s.settingsHeader}>
            <span style={{ ...s.settingsTitle, color: c.text }}>Configuration</span>
            <button onClick={() => setShowSettings(false)} style={{ ...s.closeSettingsBtn, color: c.sub }}>✕</button>
          </div>

          <div style={s.settingsGrid}>
            <div style={s.formGroup}>
              <label style={{ ...s.label, color: c.sub }}>Provider</label>
              <select
                value={providerType}
                onChange={(e) => {
                  setProviderType(e.target.value);
                  setEndpoint(e.target.value === 'local' ? 'http://localhost:11434' : 'https://api.openai.com/v1');
                }}
                style={{ ...s.selectField, background: c.inputBg, color: c.text, border: `1px solid ${c.border}` }}
              >
                <option value="local">Local (Ollama / vLLM)</option>
                <option value="cloud">Cloud (OpenAI / Anthropic)</option>
              </select>
            </div>

            <div style={s.formGroup}>
              <label style={{ ...s.label, color: c.sub }}>Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="ui-tars, gpt-4o, qwen2.5-vl"
                style={{ ...s.inputField, background: c.inputBg, color: c.text, border: `1px solid ${c.border}` }}
              />
            </div>

            <div style={{ ...s.formGroup, gridColumn: '1 / -1' }}>
              <label style={{ ...s.label, color: c.sub }}>Endpoint</label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                style={{ ...s.inputField, background: c.inputBg, color: c.text, border: `1px solid ${c.border}` }}
              />
            </div>

            {providerType === 'cloud' && (
              <div style={{ ...s.formGroup, gridColumn: '1 / -1' }}>
                <label style={{ ...s.label, color: c.sub }}>API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  style={{ ...s.inputField, background: c.inputBg, color: c.text, border: `1px solid ${c.border}` }}
                />
              </div>
            )}

            <div style={s.formGroup}>
              <label style={{ ...s.label, color: c.sub }}>Opacity: {opacity}%</label>
              <input
                type="range" min="30" max="100" value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                style={s.slider}
              />
            </div>

            <div style={s.formGroup}>
              <label style={{ ...s.label, color: c.sub }}>Max Steps</label>
              <input
                type="number" min="1" max="50" value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                style={{ ...s.inputField, background: c.inputBg, color: c.text, border: `1px solid ${c.border}`, width: '70px' }}
              />
            </div>
          </div>

          <div style={s.settingsActions}>
            <button onClick={saveSettings} style={{ ...s.primaryBtn, background: c.accent, color: theme === 'dark' ? '#000' : '#fff' }}>Save</button>
            <button onClick={() => setShowSettings(false)} style={{ ...s.ghostBtn, color: c.sub, border: `1px solid ${c.border}` }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ─── Chat Messages ─── */}
      <div style={s.chatArea}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...s.msgRow,
              justifyContent: msg.sender === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                ...s.bubble,
                background: msg.sender === 'user' ? c.userBubble : c.agentBubble,
                border: `1px solid ${c.border}`,
              }}
            >
              <div style={s.msgText}>{msg.text}</div>

              {msg.screenshot && (
                <div style={{ ...s.snapWrap, border: `1px solid ${c.border}` }}>
                  <div style={{ ...s.snapLabel, color: c.sub, background: c.headerBg }}>Snapshot</div>
                  <img src={msg.screenshot} alt="capture" style={s.snapImg} />
                </div>
              )}

              {msg.thought && (
                <div style={{ ...s.trace, borderLeft: `2px solid ${c.accent}`, background: c.headerBg }}>
                  <div style={{ ...s.traceHead, color: c.accent }}>Thought</div>
                  <div style={{ ...s.traceBody, color: c.text }}>{msg.thought}</div>
                </div>
              )}

              {msg.action && (
                <div style={{ ...s.actionBlock, background: c.inputBg, border: `1px solid ${c.border}` }}>
                  <span style={{ ...s.actionLabel, color: c.accent }}>→ </span>
                  <code style={{ fontSize: '0.78rem', color: c.text }}>{msg.action}</code>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* ─── Input Bar ─── */}
      <form onSubmit={handleSend} style={{ ...s.inputBar, background: theme === 'dark' ? 'rgba(18,18,18,0.8)' : 'rgba(244,244,245,0.8)', borderTop: `1px solid ${c.border}` }}>
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={isProcessing ? 'Executing...' : 'Describe a task...'}
          disabled={isProcessing}
          style={{ ...s.chatInput, background: c.inputBg, color: c.text, border: `1px solid ${c.border}` }}
        />
        <button
          type="submit"
          disabled={isProcessing || !instruction.trim()}
          style={{
            ...s.sendBtn,
            background: c.accent,
            color: theme === 'dark' ? '#000' : '#fff',
            opacity: (isProcessing || !instruction.trim()) ? 0.4 : 1,
            cursor: (isProcessing || !instruction.trim()) ? 'not-allowed' : 'pointer',
          }}
        >
          {isProcessing ? '...' : '↑'}
        </button>
      </form>
    </div>
  );
}

/* ─── Color Palettes ─── */
const darkColors = {
  text: '#e4e4e7',
  sub: '#71717a',
  border: '#27272a',
  headerBg: '#141414',
  btnBg: '#1e1e1e',
  inputBg: '#1a1a1a',
  userBubble: '#1e1e1e',
  agentBubble: '#141414',
  accent: '#e4e4e7',
};

const lightColors = {
  text: '#18181b',
  sub: '#a1a1aa',
  border: '#e4e4e7',
  headerBg: '#f4f4f5',
  btnBg: '#ebebec',
  inputBg: '#ffffff',
  userBubble: '#f4f4f5',
  agentBubble: '#ffffff',
  accent: '#18181b',
};

/* ─── Styles ─── */
const s: Record<string, React.CSSProperties> = {
  shell: {
    display: 'flex',
    flexDirection: 'column',
    position: 'absolute',
    inset: 0,
    borderRadius: '12px',
    border: '1px solid',
    overflow: 'hidden',
    fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif",
    fontSize: '13px',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
  },
  // Titlebar
  titlebar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: '38px',
    padding: '0 12px',
    userSelect: 'none',
    flexShrink: 0,
    zIndex: 1000,
  },
  titleLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    pointerEvents: 'none',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    transition: 'all 0.3s ease',
  },
  titleText: {
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.02em',
  },
  titleSub: {
    fontSize: '10px',
    fontWeight: 400,
    opacity: 0.5,
  },
  titleRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    zIndex: 1010,
  },
  winBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '6px 8px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
    transition: 'opacity 0.15s',
    pointerEvents: 'auto',
  },
  winBtnClose: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '6px 8px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
    transition: 'all 0.15s',
    pointerEvents: 'auto',
  },
  // Toolbar
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 12px',
    flexShrink: 0,
  },
  toolGroup: {
    display: 'flex',
    gap: '4px',
  },
  toolBtn: {
    padding: '3px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    transition: 'all 0.15s',
    lineHeight: '20px',
  },
  panicBtn: {
    background: '#7f1d1d',
    border: '1px solid #991b1b',
    color: '#fca5a5',
    padding: '3px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
    lineHeight: '20px',
  },
  errorBanner: {
    background: '#450a0a',
    color: '#fca5a5',
    padding: '8px 14px',
    fontSize: '11px',
    flexShrink: 0,
  },
  // Settings
  settingsPanel: {
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flexShrink: 0,
  },
  settingsHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  settingsTitle: {
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  closeSettingsBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '2px 6px',
  },
  settingsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '10px',
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  selectField: {
    borderRadius: '6px',
    padding: '6px 8px',
    fontSize: '12px',
    outline: 'none',
    appearance: 'none' as const,
  },
  inputField: {
    borderRadius: '6px',
    padding: '6px 8px',
    fontSize: '12px',
    outline: 'none',
  },
  slider: {
    width: '100%',
    accentColor: '#71717a',
    cursor: 'pointer',
    height: '4px',
  },
  settingsActions: {
    display: 'flex',
    gap: '6px',
  },
  primaryBtn: {
    border: 'none',
    padding: '5px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '11px',
  },
  ghostBtn: {
    background: 'transparent',
    padding: '5px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '11px',
  },
  // Chat
  chatArea: {
    flex: 1,
    padding: '14px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  msgRow: {
    display: 'flex',
    maxWidth: '92%',
  },
  bubble: {
    padding: '10px 13px',
    borderRadius: '10px',
    fontSize: '12.5px',
    lineHeight: 1.45,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  msgText: {
    wordBreak: 'break-word',
  },
  snapWrap: {
    marginTop: '4px',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  snapLabel: {
    fontSize: '9px',
    padding: '3px 8px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  snapImg: {
    width: '100%',
    maxHeight: '200px',
    objectFit: 'contain',
    display: 'block',
  },
  trace: {
    borderRadius: '4px',
    padding: '6px 10px',
  },
  traceHead: {
    fontSize: '9px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginBottom: '2px',
  },
  traceBody: {
    fontSize: '11.5px',
  },
  actionBlock: {
    fontSize: '11.5px',
    padding: '5px 8px',
    borderRadius: '6px',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
  },
  actionLabel: {
    fontWeight: 600,
  },
  // Input bar
  inputBar: {
    display: 'flex',
    padding: '10px 12px',
    gap: '8px',
    flexShrink: 0,
  },
  chatInput: {
    flex: 1,
    borderRadius: '8px',
    padding: '9px 12px',
    fontSize: '12.5px',
    outline: 'none',
  },
  sendBtn: {
    border: 'none',
    width: '36px',
    height: '36px',
    borderRadius: '8px',
    fontWeight: 700,
    fontSize: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'opacity 0.15s',
  },
};
