import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalPosition, LogicalSize, currentMonitor } from '@tauri-apps/api/window';
import { 
  Settings, 
  RotateCcw, 
  Sun, 
  Moon, 
  Minus, 
  Columns, 
  X, 
  Send,
  Loader2,
  AlertTriangle,
  Play,
  HelpCircle
} from 'lucide-react';

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
      text: 'Ready. Describe a task, and I will automate your desktop.',
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

  // Content protection on mount
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
  const toggleSidebarMode = async () => {
    try {
      const monitor = await currentMonitor();
      if (monitor) {
        const win = getCurrentWebviewWindow();
        const scaleFactor = monitor.scaleFactor;
        const workAreaSize = monitor.workArea.size.toLogical(scaleFactor);
        const workAreaPos = monitor.workArea.position.toLogical(scaleFactor);

        const sidebarWidth = 420;
        const targetHeight = workAreaSize.height;
        const targetX = workAreaPos.x + workAreaSize.width - sidebarWidth;
        const targetY = workAreaPos.y;

        const currentSize = await win.innerSize();
        const logicalCurrentSize = currentSize.toLogical(scaleFactor);

        const isSidebar = Math.abs(logicalCurrentSize.width - sidebarWidth) < 15 && 
                          Math.abs(logicalCurrentSize.height - targetHeight) < 15;

        if (isSidebar) {
          await win.setSize(new LogicalSize(460, 680));
          await win.center();
        } else {
          await win.setSize(new LogicalSize(sidebarWidth, targetHeight));
          await win.setPosition(new LogicalPosition(targetX, targetY));
        }
      }
    } catch (err) {
      console.error('Failed toggling sidebar layout mode:', err);
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

  const bgStyle = {
    backgroundColor: theme === 'dark' 
      ? `rgba(10, 10, 10, ${opacity / 100})` 
      : `rgba(250, 250, 250, ${opacity / 100})`,
  };

  return (
    <div 
      style={bgStyle} 
      className={`flex flex-col absolute inset-0 rounded-xl border overflow-hidden font-sans text-[13px] backdrop-blur-2xl transition-colors duration-200
        ${theme === 'dark' ? 'text-zinc-200 border-zinc-800/80 shadow-2xl shadow-black/80' : 'text-zinc-800 border-zinc-200/80 shadow-2xl shadow-zinc-300/40'}`}
    >
      {/* ─── Custom Titlebar ─── */}
      <div 
        onMouseDown={handleMouseDown}
        className={`flex justify-between items-center h-[38px] px-3 select-none flex-shrink-0 z-50 border-b
          ${theme === 'dark' ? 'border-zinc-800/60 bg-zinc-950/40' : 'border-zinc-200/60 bg-zinc-100/40'}`}
      >
        {/* Left Controls (Settings, Reset, Theme Toggle, Status) */}
        <div className="flex items-center gap-1.5 pointer-events-auto">
          {/* Status Dot */}
          <div className="flex items-center justify-center w-5 h-5 mr-1">
            {isProcessing ? (
              <Loader2 className="w-3.5 h-3.5 text-emerald-500 animate-spin" />
            ) : (
              <div className={`w-2 h-2 rounded-full ${theme === 'dark' ? 'bg-zinc-400' : 'bg-zinc-500'}`} />
            )}
          </div>
          
          <button 
            onClick={() => setShowSettings(!showSettings)} 
            className="win-btn p-1.5 rounded-md hover:bg-zinc-500/15 text-zinc-400 hover:text-zinc-100 transition-colors"
            title="Configuration Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          
          <button 
            onClick={clearSession} 
            className="win-btn p-1.5 rounded-md hover:bg-zinc-500/15 text-zinc-400 hover:text-zinc-100 transition-colors"
            title="New Session / Reset"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          
          <button 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} 
            className="win-btn p-1.5 rounded-md hover:bg-zinc-500/15 text-zinc-400 hover:text-zinc-100 transition-colors"
            title="Toggle theme mode"
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          {isProcessing && (
            <button 
              onClick={triggerManualPanic} 
              className="ml-2 px-2.5 py-0.5 bg-red-950/80 border border-red-800 text-red-300 rounded text-[10px] font-bold tracking-wide uppercase hover:bg-red-900 transition-colors cursor-pointer"
              title="Stop Agent Loop Execution (Shift+ESC)"
            >
              Panic Stop
            </button>
          )}
        </div>

        {/* Right Window Controls */}
        <div className="flex items-center gap-0.5 z-[1010] pointer-events-auto">
          <button 
            onClick={minimizeWindow} 
            className="win-btn p-1.5 rounded-md text-zinc-500 hover:text-zinc-100 transition-colors" 
            title="Minimize"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button 
            onClick={toggleSidebarMode} 
            className="win-btn p-1.5 rounded-md text-zinc-500 hover:text-zinc-100 transition-colors" 
            title="Toggle Sidebar Layout"
          >
            <Columns className="w-3.5 h-3.5" />
          </button>
          <button 
            onClick={closeWindow} 
            className="win-btn-close p-1.5 rounded-md text-zinc-500 hover:text-zinc-100 transition-colors" 
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ─── Error Banner ─── */}
      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-950/70 border-b border-red-900/60 text-red-300 text-[11px] flex-shrink-0 animate-fade-in">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          <div className="truncate"><strong>Error:</strong> {errorMsg}</div>
        </div>
      )}

      {/* ─── Main Viewport Area ─── */}
      <div className="flex-1 relative flex flex-col overflow-hidden">
        
        {/* Chat / Messages List */}
        <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-3 scroll-smooth">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[90%] px-3.5 py-2.5 rounded-xl text-[12.5px] leading-relaxed border flex flex-col gap-2 shadow-sm
                  ${msg.sender === 'user' 
                    ? (theme === 'dark' ? 'bg-zinc-900 border-zinc-800/80 text-zinc-200' : 'bg-zinc-100 border-zinc-200/80 text-zinc-800') 
                    : (theme === 'dark' ? 'bg-zinc-950/40 border-zinc-900 text-zinc-300' : 'bg-white border-zinc-200 text-zinc-700')}`}
              >
                <div>{msg.text}</div>

                {msg.screenshot && (
                  <div className={`mt-1.5 rounded-lg overflow-hidden border ${theme === 'dark' ? 'border-zinc-800' : 'border-zinc-200'}`}>
                    <div className={`text-[9px] px-2 py-1 uppercase tracking-wider font-semibold 
                      ${theme === 'dark' ? 'bg-zinc-900 text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}>
                      State Capture Snapshot
                    </div>
                    <img src={msg.screenshot} alt="capture" className="w-full max-h-[220px] object-contain block" />
                  </div>
                )}

                {msg.thought && (
                  <div className={`rounded-lg p-2.5 border-l-2 text-[11.5px]
                    ${theme === 'dark' ? 'bg-zinc-950/70 border-zinc-500 text-zinc-400' : 'bg-zinc-50 border-zinc-600 text-zinc-600'}`}>
                    <div className="text-[9px] font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                      <HelpCircle className="w-3 h-3" /> System-2 Thought Trace
                    </div>
                    <div>{msg.thought}</div>
                  </div>
                )}

                {msg.action && (
                  <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border font-mono text-[11px]
                    ${theme === 'dark' ? 'bg-zinc-950 border-zinc-800 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-800'}`}>
                    <Play className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                    <code className="break-all">{msg.action}</code>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Settings Overlay Panel */}
        {showSettings && (
          <div className={`absolute inset-x-0 top-0 p-4 border-b flex flex-col gap-3 z-45 animate-slide-down backdrop-blur-xl shadow-md
            ${theme === 'dark' ? 'bg-zinc-950/95 border-zinc-800/80' : 'bg-white/95 border-zinc-200/80'}`}>
            <div className="flex justify-between items-center">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Configuration Profile</span>
              <button onClick={() => setShowSettings(false)} className="text-zinc-500 hover:text-zinc-200 text-xs p-1 rounded hover:bg-zinc-500/10">✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Provider Source</label>
                <select
                  value={providerType}
                  onChange={(e) => {
                    setProviderType(e.target.value);
                    setEndpoint(e.target.value === 'local' ? 'http://localhost:11434' : 'https://api.openai.com/v1');
                  }}
                  className={`rounded-lg px-2.5 py-1.5 text-xs outline-none border cursor-pointer
                    ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-800'}`}
                >
                  <option value="local">Local (Ollama / vLLM)</option>
                  <option value="cloud">Cloud (OpenAI / Compatible)</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model Name</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. minimax-m3:cloud"
                  className={`rounded-lg px-2.5 py-1.5 text-xs outline-none border
                    ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-800'}`}
                />
              </div>

              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">API Endpoint URL</label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs outline-none border
                    ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-800'}`}
                />
              </div>

              {providerType === 'cloud' && (
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">API Key Header</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className={`rounded-lg px-2.5 py-1.5 text-xs outline-none border
                    ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-800'}`}
                  />
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Opacity: {opacity}%</label>
                <input
                  type="range" min="30" max="100" value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-zinc-400 mt-2"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Max Iteration Steps</label>
                <input
                  type="number" min="1" max="50" value={maxSteps}
                  onChange={(e) => setMaxSteps(Number(e.target.value))}
                  className={`rounded-lg px-2.5 py-1.5 text-xs outline-none border w-20
                    ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-800'}`}
                />
              </div>
            </div>

            <div className="flex gap-2 mt-2">
              <button 
                onClick={saveSettings} 
                className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm hover:opacity-90 cursor-pointer
                  ${theme === 'dark' ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-900 text-zinc-100'}`}
              >
                Save Profile
              </button>
              <button 
                onClick={() => setShowSettings(false)} 
                className={`px-4 py-1.5 rounded-lg text-xs border transition-all cursor-pointer
                  ${theme === 'dark' ? 'border-zinc-800 text-zinc-400 hover:bg-zinc-900' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'}`}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── Bottom Chat Input Area ─── */}
      <form 
        onSubmit={handleSend} 
        className={`flex p-3 gap-2 border-t flex-shrink-0 transition-colors
          ${theme === 'dark' ? 'bg-zinc-950/65 border-zinc-900' : 'bg-zinc-100/65 border-zinc-200'}`}
      >
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={isProcessing ? 'Executing automated cycle steps...' : 'Describe a task...'}
          disabled={isProcessing}
          className={`flex-1 rounded-lg px-3.5 py-2 text-xs outline-none border transition-all duration-200
            ${theme === 'dark' 
              ? 'bg-zinc-900/60 border-zinc-800/80 text-zinc-100 focus:border-zinc-600 focus:bg-zinc-900' 
              : 'bg-white border-zinc-200/80 text-zinc-850 focus:border-zinc-400 focus:bg-white'}`}
        />
        <button
          type="submit"
          disabled={isProcessing || !instruction.trim()}
          className={`flex items-center justify-center w-8 h-8 rounded-lg font-semibold transition-all shadow-sm cursor-pointer
            ${theme === 'dark' 
              ? 'bg-zinc-100 text-zinc-950 disabled:bg-zinc-800 disabled:text-zinc-600' 
              : 'bg-zinc-900 text-zinc-100 disabled:bg-zinc-200 disabled:text-zinc-400'}`}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>
    </div>
  );
}
