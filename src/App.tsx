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
  Pin
} from 'lucide-react';

interface AgentStep {
  id: string;
  thought?: string;
  action?: string;
  status?: string;
  screenshot?: string;
}

interface Message {
  id: string;
  sender: 'user' | 'hiro';
  text: string;
  screenshot?: string;
  steps?: AgentStep[];
}

interface AgentStepPayload {
  status: string;
  thought: string | null;
  action: string | null;
  mcp_tool_call: string | null;
}

function parseActionLabel(action: string | undefined): { label: string; param: string } {
  if (!action) {
    return { label: "Thinking", param: "" };
  }
  const clean = action.replace(/^Action:\s*/, "").trim();
  let label = "Interacting";
  let param = "";

  if (clean.startsWith("click")) {
    label = "Click";
    const match = clean.match(/target='([^']+)'/) || clean.match(/start_box='([^']+)'/);
    if (match) param = match[1];
  } else if (clean.startsWith("left_double")) {
    label = "Double Click";
    const match = clean.match(/target='([^']+)'/) || clean.match(/start_box='([^']+)'/);
    if (match) param = match[1];
  } else if (clean.startsWith("right_single")) {
    label = "Right Click";
    const match = clean.match(/target='([^']+)'/) || clean.match(/start_box='([^']+)'/);
    if (match) param = match[1];
  } else if (clean.startsWith("drag")) {
    label = "Drag";
    const matchStart = clean.match(/start_box='([^']+)'/);
    const matchEnd = clean.match(/end_box='([^']+)'/);
    if (matchStart && matchEnd) param = `${matchStart[1]} ➔ ${matchEnd[1]}`;
  } else if (clean.startsWith("type")) {
    label = "Type";
    const match = clean.match(/content='([^']+)'/);
    if (match) param = match[1];
  } else if (clean.startsWith("scroll")) {
    label = "Scroll";
    const match = clean.match(/direction='([^']+)'/);
    if (match) param = match[1];
  } else if (clean.startsWith("hotkey")) {
    label = "Hotkey";
    const match = clean.match(/key='([^']+)'/);
    if (match) param = match[1];
  } else if (clean.startsWith("finished")) {
    label = "Finished";
  } else if (clean.startsWith("call_user")) {
    label = "Call User";
  } else if (clean.startsWith("wait")) {
    label = "Wait";
    const match = clean.match(/seconds=(\d+)/);
    if (match) param = `${match[1]}s`;
  }

  return { label, param };
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
  const [expandedMessageIds, setExpandedMessageIds] = useState<Record<string, boolean>>({});
  const [clarifyQuestion, setClarifyQuestion] = useState<{ title: string; options: string[] } | null>(null);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isPinned, setIsPinned] = useState(false);
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
        
        // Ensure the last message is a hiro response block
        if (!lastMessage || lastMessage.sender !== 'hiro' || lastMessage.id === 'welcome' || lastMessage.id.startsWith('reset-')) {
          return [
            ...prev,
            {
              id: 'hiro-' + Date.now(),
              sender: 'hiro',
              text: payload.thought || 'Processing...',
              steps: [
                {
                  id: Math.random().toString(),
                  thought: payload.thought || undefined,
                  action: payload.action || undefined,
                  status: payload.status,
                }
              ]
            }
          ];
        }

        // We have a lastMessage that is a hiro response step card. Let's update its steps list.
        const steps = lastMessage.steps ? [...lastMessage.steps] : [];
        const lastStep = steps[steps.length - 1];

        // A step is considered "finished writing" if we already recorded an action for it,
        // and the incoming payload is starting a new VLM thought (i.e. action is null).
        const isNewStepStarting = lastStep && lastStep.action && !payload.action;

        if (lastStep && !isNewStepStarting && lastStep.status !== 'completed' && lastStep.status !== 'aborted') {
          steps[steps.length - 1] = {
            ...lastStep,
            thought: payload.thought || lastStep.thought,
            action: payload.action || lastStep.action,
            status: payload.status,
          };
        } else {
          steps.push({
            id: Math.random().toString(),
            thought: payload.thought || undefined,
            action: payload.action || undefined,
            status: payload.status,
          });
        }

        return [
          ...prev.slice(0, -1),
          {
            ...lastMessage,
            text: payload.thought || lastMessage.text,
            steps: steps,
          }
        ];
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
    if (!instruction.trim()) return;

    const userText = instruction;
    setInstruction('');

    if (isProcessing) {
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: 'user',
          text: userText,
        },
      ]);
      try {
        await invoke('inject_user_hint', { hint: userText });
      } catch (err) {
        console.error('Failed to inject user steering hint:', err);
      }
      return;
    }

    setErrorMsg(null);
    const userMessageId = Math.random().toString();

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
call_user()
wait(seconds=NUM_SECONDS) (use when waiting for transitions, loading bars, animations, or server responses before taking the next screenshot)

## Guidelines
- Before typing any text using type(content='TEXT_STRING'), ALWAYS perform a click action on the target input box/text area first to ensure it has keyboard focus.
- When typing content into chat boxes, input fields, or prompt boxes, prefer sending it by pressing Enter via hotkey(key='enter') rather than visually targeting and clicking the Send/Submit button. This is faster and avoids click precision issues.`;

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
  const togglePinWindow = async () => {
    try {
      const win = getCurrentWebviewWindow();
      const nextPinState = !isPinned;
      await win.setAlwaysOnTop(nextPinState);
      setIsPinned(nextPinState);
    } catch (err) {
      console.error('Failed toggling pin window state:', err);
    }
  };

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
              onClick={togglePinWindow} 
              className={`win-btn p-1.5 rounded-md transition-colors cursor-pointer
                ${isPinned ? 'text-emerald-500 hover:text-emerald-450' : 'text-zinc-550 hover:text-zinc-100'}`} 
              title={isPinned ? "Unpin Window" : "Pin Window (Always on Top)"}
            >
              <Pin className={`w-3 h-3 ${isPinned ? 'rotate-45' : ''} transition-transform`} />
            </button>
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
          {messages.map((msg, index) => {
            const isUser = msg.sender === 'user';
            const isLastMessage = index === messages.length - 1;
            
            return (
              <div
                key={msg.id}
                className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {isUser ? (
                  <div
                    className={`max-w-[85%] px-3 py-1.5 rounded-xl text-[12.5px] leading-relaxed shadow-sm
                      ${theme === 'dark' ? 'bg-zinc-900/60 text-zinc-200' : 'bg-zinc-100 text-zinc-850'}`}
                  >
                    <div>{msg.text}</div>
                  </div>
                ) : (
                  <div className="w-full text-[12.5px] leading-relaxed flex flex-col gap-2.5">
                    {msg.steps && msg.steps.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {msg.steps.map((step, stepIndex) => {
                          const isLastStep = stepIndex === msg.steps!.length - 1;
                          const isStepRunning = isLastStep && isProcessing && isLastMessage;
                          const shouldDefaultOpen = isLastStep && isLastMessage;
                          const isOpen = expandedMessageIds[step.id] ?? shouldDefaultOpen;
                          const actionInfo = parseActionLabel(step.action);

                          return (
                            <details 
                              key={step.id}
                              className="group/details cursor-pointer w-full border-none bg-transparent"
                              open={isOpen}
                              onToggle={(e) => {
                                const isDomOpen = (e.target as HTMLDetailsElement).open;
                                if (isDomOpen !== isOpen) {
                                  setExpandedMessageIds(prev => ({ ...prev, [step.id]: isDomOpen }));
                                }
                              }}
                            >
                              <summary className="flex items-center gap-1.5 font-medium list-none select-none text-zinc-400 hover:text-zinc-200">
                                {/* Minimal plus indicator */}
                                <span className="text-[11px] text-zinc-500 font-mono w-3.5 h-3.5 flex items-center justify-center select-none">
                                  +
                                </span>
                                
                                {/* Collapsed view: Action + Shimmer effect if running/active */}
                                <div className={`group-open/details:hidden ${isStepRunning ? 'shimmer-text font-semibold' : ''} flex items-center min-w-0 max-w-[340px] truncate`}>
                                  <span className={`${theme === 'dark' ? 'text-zinc-300' : 'text-zinc-850'} font-semibold flex-shrink-0`}>
                                    {actionInfo.label}
                                  </span>
                                  {actionInfo.param && (
                                    <span className="text-zinc-550 ml-1.5 font-normal truncate block select-none">
                                      {actionInfo.param}
                                    </span>
                                  )}
                                </div>

                                {/* Expanded view: Header action name */}
                                <div className="hidden group-open/details:inline font-semibold text-zinc-400">
                                  {actionInfo.label}
                                </div>
                              </summary>

                              {/* Expanded Indented Monochromatic Log Body */}
                              <div className="mt-2 pl-4 flex flex-col gap-2 cursor-default border-l border-zinc-800/40">
                                {step.thought && (
                                  <div className={`text-[12px] leading-relaxed max-w-[95%] ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>
                                    {step.thought}
                                  </div>
                                )}

                                {step.action && (
                                  <div className="font-mono text-[11px] text-zinc-500 break-all select-all">
                                    {step.action}
                                  </div>
                                )}

                                {step.screenshot && (
                                  <div className={`rounded-lg overflow-hidden border max-w-sm mt-1 transition-opacity duration-200 opacity-70 hover:opacity-100
                                    ${theme === 'dark' ? 'border-zinc-800/60' : 'border-zinc-200/60'}`}>
                                    <img src={step.screenshot} alt="capture" className="w-full max-h-[160px] object-contain block" />
                                  </div>
                                )}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    ) : (
                      // Handle static text response when steps list is empty (e.g. initial welcomes)
                      <div className={theme === 'dark' ? 'text-zinc-300' : 'text-zinc-800'}>
                        {msg.text}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
        {/* Clarification Questions Card */}
        {clarifyQuestion && (
          <div className={`mb-3 p-3.5 rounded-[20px] border shadow-md flex flex-col gap-3 animate-slide-up
            ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-800'}`}>
            
            <div className="flex justify-between items-center px-0.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Clarification Request</span>
              <button 
                onClick={() => setClarifyQuestion(null)}
                className="text-zinc-500 hover:text-zinc-300 text-xs p-0.5 rounded cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="text-[12.5px] font-semibold leading-snug">
              {clarifyQuestion.title}
            </div>

            <div className="flex flex-col gap-2 my-1">
              {clarifyQuestion.options.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelectedOption(i)}
                  className={`flex items-center gap-2.5 w-full text-left p-2 rounded-xl border text-[12px] transition-all cursor-pointer
                    ${selectedOption === i 
                      ? (theme === 'dark' ? 'border-zinc-400 bg-zinc-850 text-zinc-100' : 'border-zinc-500 bg-zinc-50 text-zinc-900') 
                      : (theme === 'dark' ? 'border-zinc-800/80 hover:bg-zinc-800/40 text-zinc-455' : 'border-zinc-200 hover:bg-zinc-50 text-zinc-655')}`}
                >
                  <span className={`w-4 h-4 rounded text-[9.5px] font-semibold flex items-center justify-center border font-mono
                    ${selectedOption === i 
                      ? 'bg-zinc-150 text-zinc-950 border-transparent' 
                      : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                  >
                    {i + 1}
                  </span>
                  <span>{opt}</span>
                </button>
              ))}
            </div>

            <div className="flex justify-end gap-2 text-xs pt-1 border-t border-zinc-800/40">
              <button
                type="button"
                onClick={() => {
                  setClarifyQuestion(null);
                  setSelectedOption(null);
                }}
                className="px-3 py-1 rounded-lg text-zinc-500 hover:text-zinc-300 font-medium transition-colors cursor-pointer"
              >
                Skip
              </button>
              <button
                type="button"
                disabled={selectedOption === null}
                onClick={async () => {
                  if (selectedOption !== null) {
                    const text = clarifyQuestion.options[selectedOption];
                    setClarifyQuestion(null);
                    setSelectedOption(null);
                    
                    setInstruction(text);
                    setTimeout(() => {
                      const triggerBtn = document.getElementById("send-btn-trigger");
                      if (triggerBtn) triggerBtn.click();
                    }, 50);
                  }
                }}
                className={`px-4 py-1.5 rounded-lg font-semibold shadow transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
                  ${theme === 'dark' 
                    ? 'bg-zinc-100 text-zinc-950 hover:bg-zinc-200' 
                    : 'bg-zinc-950 text-white hover:bg-zinc-900'}`}
              >
                Continue
              </button>
            </div>
          </div>
        )}

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
            placeholder={isProcessing ? 'Steer agent with hints...' : 'Ask anything...'}
            className="w-full bg-transparent px-2.5 py-1.5 text-[13px] outline-none border-none placeholder-zinc-400"
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

            {/* Conditional Stop / Steer / Send Controls */}
            <div className="flex items-center">
              {isProcessing ? (
                <>
                  {instruction.trim() && (
                    <button
                      id="send-btn-trigger"
                      type="submit"
                      className={`flex items-center justify-center w-7 h-7 rounded-full font-semibold transition-all shadow-sm cursor-pointer mr-1.5
                        ${theme === 'dark' 
                          ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400' 
                          : 'bg-emerald-600 text-white hover:bg-emerald-550'}`}
                      title="Steer Agent"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 5v14"/></svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={triggerManualPanic}
                    className="flex items-center justify-center w-7 h-7 rounded-full bg-red-950/80 border border-red-800 text-red-300 hover:bg-red-900 transition-all shadow-sm cursor-pointer"
                    title="Stop Agent Execution (Shift+ESC)"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  </button>
                </>
              ) : (
                <button
                  id="send-btn-trigger"
                  type="submit"
                  disabled={!instruction.trim()}
                  className={`flex items-center justify-center w-7 h-7 rounded-full font-semibold transition-all shadow-sm cursor-pointer
                    ${theme === 'dark' 
                      ? 'bg-zinc-100 text-zinc-950 hover:bg-zinc-200 disabled:bg-zinc-800/50 disabled:text-zinc-600' 
                      : 'bg-zinc-950 text-white hover:bg-zinc-900 disabled:bg-zinc-100 disabled:text-zinc-300'}`}
                  title="Send Task"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 5v14"/></svg>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
