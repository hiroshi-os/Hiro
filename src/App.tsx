import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
      text: 'Welcome! I am Hiro, your visual-agent desktop automation platform. Configured with solid monochrome theme options.',
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Theme Toggle: 'dark' or 'light'
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  
  // Settings Panel Config
  const [showSettings, setShowSettings] = useState(false);
  const [providerType, setProviderType] = useState('local');
  const [endpoint, setEndpoint] = useState('http://localhost:11434/api/generate');
  const [apiKey, setApiKey] = useState('');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
              text: payload.mcp_tool_call || payload.thought || 'Processing next environment state...',
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

    // Prompt Construction block — Hybrid Architecture (Coordinates + Template Grounding)
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
          text: `Error initializing execution cycle: ${err}`,
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
        }
      });
      setShowSettings(false);
    } catch (err) {
      alert(`Failed to save routing profile settings: ${err}`);
    }
  };

  const triggerManualPanic = async () => {
    try {
      await invoke('trigger_panic');
    } catch (err) {
      console.error('Panic trigger call failed:', err);
    }
  };

  const currentColors = theme === 'dark' ? darkColors : lightColors;

  return (
    <div style={{ ...styles.container, background: currentColors.background, color: currentColors.text }}>
      <header style={{ ...styles.header, borderBottom: `1px solid ${currentColors.border}`, background: currentColors.headerBg }}>
        <div style={styles.logoContainer}>
          <div style={{ ...styles.indicator, background: currentColors.accent }} />
          <span style={{ ...styles.title, color: currentColors.text }}>Hiro Desktop</span>
        </div>
        <div style={styles.systemBadge}>
          <button 
            style={{ ...styles.themeBtn, color: currentColors.text, border: `1px solid ${currentColors.border}`, background: currentColors.buttonBg }} 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <button 
            style={{ ...styles.settingsBtn, color: currentColors.text, border: `1px solid ${currentColors.border}`, background: currentColors.buttonBg }} 
            onClick={() => setShowSettings(!showSettings)}
          >
            Settings
          </button>
          {isProcessing && (
            <button style={styles.panicBtn} onClick={triggerManualPanic}>
              Panic Stop (Shift+ESC)
            </button>
          )}
        </div>
      </header>

      {errorMsg && (
        <div style={styles.errorBanner}>
          <strong>Security Boundary Intercept:</strong> {errorMsg}
        </div>
      )}

      {showSettings && (
        <div style={{ ...styles.settingsModal, background: currentColors.headerBg, borderBottom: `1px solid ${currentColors.border}` }}>
          <h3 style={{ ...styles.modalTitle, color: currentColors.text }}>Provider Profile Routing</h3>
          <div style={styles.formGroup}>
            <label style={{ ...styles.label, color: currentColors.subtext }}>Inference Source</label>
            <select
              value={providerType}
              onChange={(e) => {
                setProviderType(e.target.value);
                if (e.target.value === 'local') {
                  setEndpoint('http://localhost:11434/api/generate');
                } else {
                  setEndpoint('https://api.openai.com/v1/chat/completions');
                }
              }}
              style={{ ...styles.select, background: currentColors.inputBg, color: currentColors.text, border: `1px solid ${currentColors.border}` }}
            >
              <option value="local">Local Host (Ollama / vLLM)</option>
              <option value="cloud">Cloud API Provider (OpenAI/Anthropic)</option>
            </select>
          </div>
          <div style={styles.formGroup}>
            <label style={{ ...styles.label, color: currentColors.subtext }}>Endpoint URL</label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              style={{ ...styles.input, background: currentColors.inputBg, color: currentColors.text, border: `1px solid ${currentColors.border}` }}
            />
          </div>
          {providerType === 'cloud' && (
            <div style={styles.formGroup}>
              <label style={{ ...styles.label, color: currentColors.subtext }}>API Key Header Token</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                style={{ ...styles.input, background: currentColors.inputBg, color: currentColors.text, border: `1px solid ${currentColors.border}` }}
              />
            </div>
          )}
          <div style={styles.modalActions}>
            <button onClick={saveSettings} style={{ ...styles.saveBtn, background: currentColors.accent, color: theme === 'dark' ? '#000' : '#fff' }}>Save Settings</button>
            <button onClick={() => setShowSettings(false)} style={{ ...styles.cancelBtn, color: currentColors.subtext, border: `1px solid ${currentColors.border}` }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={styles.chatArea}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...styles.messageRow,
              justifyContent: msg.sender === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                ...styles.bubble,
                background: msg.sender === 'user' ? currentColors.userBubble : currentColors.agentBubble,
                border: `1px solid ${currentColors.border}`,
              }}
            >
              <div style={styles.messageText}>{msg.text}</div>
              
              {msg.screenshot && (
                <div style={{ ...styles.screenshotContainer, border: `1px solid ${currentColors.border}` }}>
                  <div style={{ ...styles.screenshotLabel, color: currentColors.subtext, background: currentColors.headerBg }}>Environment Capture Snapshot:</div>
                  <img src={msg.screenshot} alt="Screen capture" style={styles.screenshot} />
                </div>
              )}

              {msg.thought && (
                <div style={{ ...styles.thinkingTrace, borderLeft: `3px solid ${currentColors.accent}`, background: currentColors.headerBg }}>
                  <div style={{ ...styles.traceHeader, color: currentColors.accent }}>System-2 Trace</div>
                  <div style={{ ...styles.traceBody, color: currentColors.text }}>{msg.thought}</div>
                </div>
              )}

              {msg.action && (
                <div style={{ ...styles.actionBlock, background: currentColors.inputBg, border: `1px solid ${currentColors.border}` }}>
                  <span style={{ ...styles.actionLabel, color: currentColors.accent }}>Action Call: </span>
                  <code>{msg.action}</code>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} style={{ ...styles.inputArea, background: currentColors.headerBg, borderTop: `1px solid ${currentColors.border}` }}>
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={isProcessing ? "Hiro is executing desktop steps..." : "Type instructions..."}
          disabled={isProcessing}
          style={{ ...styles.inputField, background: currentColors.inputBg, color: currentColors.text, border: `1px solid ${currentColors.border}` }}
        />
        <button
          type="submit"
          disabled={isProcessing || !instruction.trim()}
          style={{
            ...styles.button,
            background: currentColors.accent,
            color: theme === 'dark' ? '#000' : '#fff',
            opacity: (isProcessing || !instruction.trim()) ? 0.5 : 1,
            cursor: (isProcessing || !instruction.trim()) ? 'not-allowed' : 'pointer',
          }}
        >
          {isProcessing ? 'Running...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// Neutral Solid Palette
const darkColors = {
  background: '#121212',
  text: '#e4e4e7',
  subtext: '#a1a1aa',
  border: '#27272a',
  headerBg: '#18181b',
  buttonBg: '#27272a',
  inputBg: '#18181b',
  userBubble: '#27272a',
  agentBubble: '#18181b',
  accent: '#ffffff',
};

const lightColors = {
  background: '#ffffff',
  text: '#18181b',
  subtext: '#71717a',
  border: '#e4e4e7',
  headerBg: '#f4f4f5',
  buttonBg: '#e4e4e7',
  inputBg: '#ffffff',
  userBubble: '#f4f4f5',
  agentBubble: '#ffffff',
  accent: '#18181b',
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    boxSizing: 'border-box',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    overflow: 'hidden',
  },



  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px',
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  indicator: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  title: {
    fontSize: '1rem',
    fontWeight: 600,
  },
  systemBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  themeBtn: {
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  settingsBtn: {
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  panicBtn: {
    background: '#7f1d1d',
    border: '1px solid #b91c1c',
    color: '#fca5a5',
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  errorBanner: {
    background: '#7f1d1d',
    color: '#fca5a5',
    padding: '10px 20px',
    fontSize: '0.85rem',
  },
  settingsModal: {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  modalTitle: {
    margin: 0,
    fontSize: '0.9rem',
    fontWeight: 600,
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '0.75rem',
  },
  select: {
    borderRadius: '4px',
    padding: '6px 10px',
    fontSize: '0.85rem',
    outline: 'none',
  },
  input: {
    borderRadius: '4px',
    padding: '6px 10px',
    fontSize: '0.85rem',
    outline: 'none',
  },
  modalActions: {
    display: 'flex',
    gap: '8px',
    marginTop: '6px',
  },
  saveBtn: {
    border: 'none',
    padding: '6px 14px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.85rem',
  },
  cancelBtn: {
    background: 'transparent',
    padding: '6px 14px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  chatArea: {
    flex: 1,
    padding: '20px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  messageRow: {
    display: 'flex',
    maxWidth: '85%',
  },
  bubble: {
    padding: '12px 16px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    lineHeight: 1.4,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  messageText: {
    wordBreak: 'break-word',
  },
  screenshotContainer: {
    marginTop: '6px',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  screenshotLabel: {
    fontSize: '0.7rem',
    padding: '4px 8px',
  },
  screenshot: {
    width: '100%',
    maxHeight: '240px',
    objectFit: 'contain',
    display: 'block',
  },
  thinkingTrace: {
    borderRadius: '4px',
    padding: '8px 10px',
  },
  traceHeader: {
    fontSize: '0.7rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '2px',
  },
  traceBody: {
    fontSize: '0.8rem',
  },
  actionBlock: {
    fontSize: '0.8rem',
    padding: '6px 10px',
    borderRadius: '4px',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  },
  actionLabel: {
    fontWeight: 600,
  },
  inputArea: {
    display: 'flex',
    padding: '16px 20px',
    gap: '10px',
  },
  inputField: {
    flex: 1,
    borderRadius: '6px',
    padding: '10px 14px',
    fontSize: '0.9rem',
    outline: 'none',
  },
  button: {
    border: 'none',
    padding: '0 20px',
    borderRadius: '6px',
    fontWeight: 600,
    fontSize: '0.9rem',
  },
};
