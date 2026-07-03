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
      className={`flex flex-col absolute inset-0 rounded-xl overflow-hidden font-sans text-[13px] backdrop-blur-2xl transition-colors duration-200
        ${theme === 'dark' ? 'text-zinc-200 shadow-2xl shadow-black/80' : 'text-zinc-800 shadow-2xl shadow-zinc-300/40'}`}
    >
      {/* ─── Custom Titlebar ─── */}
      {/* ─── Custom Titlebar (Autohide Hover Trigger) ─── */}
      <div className="group/titlebar relative flex flex-col flex-shrink-0 z-50 w-full transition-all duration-300">
        {/* Invisible Top Sensor Bar (8px height) when collapsed to capture hover */}
        <div className="absolute top-0 inset-x-0 h-2 bg-transparent z-50 pointer-events-auto" />
        
        {/* Sliding & Fading Titlebar Panel */}
        <div 
          onMouseDown={handleMouseDown}
          className={`flex justify-between items-center h-0 opacity-0 pointer-events-none 
            group-hover/titlebar:h-[38px] group-hover/titlebar:opacity-100 group-hover/titlebar:pointer-events-auto 
            transition-all duration-300 ease-out px-3 select-none border-b
            ${theme === 'dark' 
              ? 'border-transparent group-hover/titlebar:border-zinc-800/60 bg-zinc-950/40' 
              : 'border-transparent group-hover/titlebar:border-zinc-200/60 bg-zinc-100/40'}`}
        >
          {/* Left Controls (Settings, Reset, Theme Toggle, Status) */}
          <div className="flex items-center gap-1.5 pointer-events-auto">
            {isProcessing && (
              <Loader2 className="w-3.5 h-3.5 mr-1 text-emerald-500 animate-spin" />
            )}
            
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
      <div className={`p-3 border-t flex-shrink-0 transition-colors ${theme === 'dark' ? 'border-zinc-900/50 bg-zinc-950/10' : 'border-zinc-200 bg-zinc-100/20'}`}>
        <form 
          onSubmit={handleSend} 
          className={`flex flex-col p-2.5 rounded-[24px] border shadow-sm transition-all duration-200
            ${theme === 'dark' 
              ? 'bg-zinc-900/40 border-zinc-800/80 text-zinc-100 focus-within:border-zinc-700/80' 
              : 'bg-white border-zinc-200/80 text-zinc-850 focus-within:border-zinc-300/80'}`}
        >
          {/* Top Line: Input Field */}
          <input
            type="text"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={isProcessing ? 'Executing automated steps...' : 'Ask anything...'}
            disabled={isProcessing}
            className="w-full bg-transparent px-2.5 py-1.5 text-[13px] outline-none border-none placeholder-zinc-400 disabled:opacity-50"
          />

          {/* Bottom Line: Controls Bar */}
          <div className="flex justify-between items-center mt-2 px-1">
            {/* Quick Action Icons */}
            <div className="flex items-center gap-1.5 pointer-events-auto">
              <button 
                type="button"
                className={`p-1.5 rounded-full border text-zinc-450 hover:text-zinc-200 transition-colors cursor-pointer
                  ${theme === 'dark' ? 'border-zinc-800/60 hover:bg-zinc-800/60' : 'border-zinc-200 hover:bg-zinc-50'}`}
                title="Attach Source Files"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              
              <button 
                type="button"
                className={`p-1.5 rounded-full border text-zinc-450 hover:text-zinc-200 transition-colors cursor-pointer
                  ${theme === 'dark' ? 'border-zinc-800/60 hover:bg-zinc-800/60' : 'border-zinc-200 hover:bg-zinc-50'}`}
                title="Search Desktop / Web"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
              </button>
              
              <button 
                type="button"
                className={`p-1.5 rounded-full border text-zinc-450 hover:text-zinc-200 transition-colors cursor-pointer
                  ${theme === 'dark' ? 'border-zinc-800/60 hover:bg-zinc-800/60' : 'border-zinc-200 hover:bg-zinc-50'}`}
                title="Toggle Reasoning Context"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
              </button>
              
              <button 
                type="button"
                className={`p-1.5 rounded-full border text-zinc-450 hover:text-zinc-200 transition-colors cursor-pointer
                  ${theme === 'dark' ? 'border-zinc-800/60 hover:bg-zinc-800/60' : 'border-zinc-200 hover:bg-zinc-50'}`}
                title="More Actions"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
              </button>
            </div>

            {/* Circular Send Button */}
            <button
              type="submit"
              disabled={isProcessing || !instruction.trim()}
              className={`flex items-center justify-center w-7 h-7 rounded-full font-semibold transition-all shadow-sm cursor-pointer
                ${theme === 'dark' 
                  ? 'bg-zinc-250 text-zinc-950 hover:bg-zinc-100 disabled:bg-zinc-800/50 disabled:text-zinc-600' 
                  : 'bg-zinc-950 text-white hover:bg-zinc-900 disabled:bg-zinc-100 disabled:text-zinc-300'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 5v14"/></svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
