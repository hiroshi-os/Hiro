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
}

export default function App() {
  const [instruction, setInstruction] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'hiro',
      text: 'Hello! I am Hiro, your desktop automation companion. I have been upgraded to the UI-TARS engine looping standard with full Coordinate Mapping, High-DPI support, Native Hotkey modifiers state protection, Non-Privileged safety bounds, and JSONL Audit logging.',
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    // Listen for agent steps emitted from Rust backend
    const unlisten = listen<AgentStepPayload>('agent-step', (event) => {
      const payload = event.payload;
      
      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        if (lastMessage && lastMessage.sender === 'hiro' && lastMessage.status !== 'completed') {
          // Update the running step details in the last message
          return [
            ...prev.slice(0, -1),
            {
              ...lastMessage,
              text: payload.thought || lastMessage.text,
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
              text: payload.thought || 'Processing next environment state...',
              thought: payload.thought || undefined,
              action: payload.action || undefined,
              status: payload.status,
            },
          ];
        }
      });

      if (payload.status === 'completed') {
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

    // Capture screenshot before agent loop kicks off
    let screenshotBase64 = '';
    try {
      screenshotBase64 = await invoke<string>('capture_screen');
    } catch (err) {
      console.error('Failed to capture screen prior to starting loop:', err);
    }

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
      await invoke('start_agent_loop', { instruction: userText });
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

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.logoContainer}>
          <div style={styles.pulse} />
          <span style={styles.title}>Hiro Desktop</span>
        </div>
        <div style={styles.systemBadge}>
          <span style={styles.badgeText}>DPI Mapped</span>
          <span style={styles.badgeText}>Audit Log: ON</span>
        </div>
      </header>

      {errorMsg && (
        <div style={styles.errorBanner}>
          <strong>Security Warning:</strong> {errorMsg}
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
            {msg.sender === 'hiro' && (
              <div style={styles.avatar}>H</div>
            )}
            <div
              style={{
                ...styles.bubble,
                background: msg.sender === 'user' ? 'linear-gradient(135deg, #4f46e5, #3b82f6)' : 'rgba(30, 41, 59, 0.7)',
                border: msg.sender === 'user' ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <div style={styles.messageText}>{msg.text}</div>
              
              {msg.screenshot && (
                <div style={styles.screenshotContainer}>
                  <div style={styles.screenshotLabel}>Environment Capture Snapshot:</div>
                  <img src={msg.screenshot} alt="Screen capture" style={styles.screenshot} />
                </div>
              )}

              {msg.thought && (
                <div style={styles.thinkingTrace}>
                  <div style={styles.traceHeader}>System-2 Trace</div>
                  <div style={styles.traceBody}>{msg.thought}</div>
                </div>
              )}

              {msg.action && (
                <div style={styles.actionBlock}>
                  <span style={styles.actionLabel}>Deterministic Action Call: </span>
                  <code>{msg.action}</code>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} style={styles.inputArea}>
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={isProcessing ? "Hiro is executing desktop steps..." : "Type instructions (e.g. 'click the web browser')..."}
          disabled={isProcessing}
          style={styles.input}
        />
        <button
          type="submit"
          disabled={isProcessing || !instruction.trim()}
          style={{
            ...styles.button,
            opacity: (isProcessing || !instruction.trim()) ? 0.5 : 1,
            cursor: (isProcessing || !instruction.trim()) ? 'not-allowed' : 'pointer',
          }}
        >
          {isProcessing ? 'Working...' : 'Run'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    backdropFilter: 'blur(20px)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    background: 'rgba(15, 23, 42, 0.4)',
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  pulse: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#10b981',
    boxShadow: '0 0 10px #10b981',
  },
  title: {
    fontSize: '1.2rem',
    fontWeight: 700,
    background: 'linear-gradient(90deg, #6366f1, #3b82f6)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  systemBadge: {
    display: 'flex',
    gap: '8px',
  },
  badgeText: {
    fontSize: '0.75rem',
    color: '#34d399',
    background: 'rgba(16, 185, 129, 0.1)',
    border: '1px solid rgba(16, 185, 129, 0.2)',
    padding: '2px 8px',
    borderRadius: '4px',
  },
  errorBanner: {
    background: 'rgba(239, 68, 68, 0.2)',
    borderBottom: '1px solid rgba(239, 68, 68, 0.4)',
    color: '#ef4444',
    padding: '12px 24px',
    fontSize: '0.9rem',
  },
  chatArea: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  messageRow: {
    display: 'flex',
    gap: '12px',
    maxWidth: '85%',
  },
  avatar: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    fontWeight: 'bold',
    color: '#fff',
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  bubble: {
    padding: '16px',
    borderRadius: '16px',
    color: '#f8fafc',
    fontSize: '0.95rem',
    lineHeight: 1.5,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
  },
  messageText: {
    wordBreak: 'break-word',
  },
  screenshotContainer: {
    marginTop: '8px',
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid rgba(255, 255, 255, 0.1)',
  },
  screenshotLabel: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    padding: '6px 10px',
    background: 'rgba(0,0,0,0.2)',
  },
  screenshot: {
    width: '100%',
    maxHeight: '260px',
    objectFit: 'contain',
    display: 'block',
  },
  thinkingTrace: {
    background: 'rgba(0, 0, 0, 0.25)',
    borderRadius: '8px',
    padding: '10px 12px',
    borderLeft: '3px solid #6366f1',
  },
  traceHeader: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#818cf8',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '4px',
  },
  traceBody: {
    fontSize: '0.85rem',
    color: '#cbd5e1',
  },
  actionBlock: {
    fontSize: '0.85rem',
    background: 'rgba(16, 185, 129, 0.1)',
    color: '#34d399',
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid rgba(16, 185, 129, 0.2)',
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  actionLabel: {
    fontWeight: 600,
  },
  inputArea: {
    display: 'flex',
    padding: '20px 24px',
    gap: '12px',
    background: 'rgba(15, 23, 42, 0.6)',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
  },
  input: {
    flex: 1,
    background: '#1e293b',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '12px',
    padding: '12px 16px',
    color: '#fff',
    fontSize: '0.95rem',
    outline: 'none',
  },
  button: {
    background: 'linear-gradient(135deg, #4f46e5, #3b82f6)',
    border: 'none',
    color: '#fff',
    padding: '0 24px',
    borderRadius: '12px',
    fontWeight: 600,
    fontSize: '0.95rem',
    transition: 'all 0.2s',
  },
};
