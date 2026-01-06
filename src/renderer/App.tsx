import React, { useState, useEffect } from 'react';
import { ipcRenderer } from 'electron';
import { Sidebar } from './components/Sidebar';
import { SettingsPage } from './components/SettingsPage';
import { RulesPage } from './components/RulesPage';
import { ChatInterface, LogItem } from './components/ChatInterface';
import { ContextPanel } from './components/ContextPanel';
import { useSettings } from './hooks/useSettings';
import './index.css';

const App = () => {
    const [activeTab, setActiveTab] = useState<'chat' | 'settings' | 'rules'>('chat');
    const { settings, updateSettings, refreshSettings } = useSettings();
    
  const [instruction, setInstruction] = useState('');
    const [logs, setLogs] = useState<LogItem[]>([]);
    // Screenshot history is kept for a single task; cleared on next start.
    const [taskImages, setTaskImages] = useState<string[]>([]);
    const [activeImageIndex, setActiveImageIndex] = useState<number>(-1);
  const [isRunning, setIsRunning] = useState(false);
  const [hasFinished, setHasFinished] = useState(false);

  const pushTaskImage = (image?: string) => {
    if (!image) return;
    setTaskImages((prev) => {
      // De-dupe adjacent duplicates (agent-thought / agent-action-plan often share the same image)
      if (prev.length && prev[prev.length - 1] === image) return prev;
      const next = [...prev, image];
      // Default behavior: always display the latest screenshot as it arrives.
      setActiveImageIndex(next.length - 1);
      return next;
    });
  };

  useEffect(() => {
    ipcRenderer.on('agent-thought', (_, payload: { text: string }) => {
            setLogs(prev => [...prev, {
                text: payload.text,
                timestamp: Date.now(),
                type: 'thought'
            }]);
    });
    
    ipcRenderer.on('agent-action-plan', (_, payload: { text: string }) => {
            setLogs(prev => [...prev, {
                text: payload.text,
                timestamp: Date.now(),
                type: 'action'
            }]);
    });

    ipcRenderer.on('agent-tool', (_, payload: { text: string }) => {
            setLogs(prev => [...prev, {
                text: payload.text,
                timestamp: Date.now(),
                type: 'tool'
            }]);
    });

    ipcRenderer.on('agent-response', (_, payload: { text: string }) => {
            setLogs(prev => [...prev, {
                text: payload.text,
                timestamp: Date.now(),
                type: 'response'
            }]);
    });

    // Dedicated image stream for Context View (no longer piggy-backed on thought/action logs)
    ipcRenderer.on('agent-image', (_, payload: { image: string }) => {
            pushTaskImage(payload.image);
    });

    ipcRenderer.on('task-finished', () => {
        setIsRunning(false);
        setHasFinished(true);
            setLogs(prev => [...prev, {
                text: "Task Finished",
                timestamp: Date.now(),
                type: 'system'
            }]);
        });
        
        ipcRenderer.on('task-error', (_, error: any) => {
            setIsRunning(false);
            setHasFinished(true);
            setLogs(prev => [...prev, {
                text: `Error: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
                timestamp: Date.now(),
                type: 'system'
            }]);
    });
    
    return () => {
        ipcRenderer.removeAllListeners('agent-thought');
        ipcRenderer.removeAllListeners('agent-action-plan');
        ipcRenderer.removeAllListeners('agent-tool');
        ipcRenderer.removeAllListeners('agent-response');
        ipcRenderer.removeAllListeners('agent-image');
        ipcRenderer.removeAllListeners('task-finished');
            ipcRenderer.removeAllListeners('task-error');
    };
  }, []);

  // When user enters Rules tab, refresh settings so external edits to rules.json are reflected.
  useEffect(() => {
    if (activeTab === 'rules') {
      refreshSettings().catch((e: any) => console.error('Failed to refresh settings', e));
    }
  }, [activeTab, refreshSettings]);

  const handleStart = () => {
        if (!instruction.trim()) return;
    setIsRunning(true);
        setHasFinished(false);
        setLogs([{
            text: `Task Started: ${instruction}`,
            timestamp: Date.now(),
            type: 'system'
        }]);
        // Clear screenshot history for new task
        setTaskImages([]);
        setActiveImageIndex(-1);
        
        // Pass settings to backend
        ipcRenderer.send('start-task', { 
            instruction,
            config: settings
        });
  };

  const handleStop = () => {
        // Optimistic update
    setIsRunning(false);
        setHasFinished(true);
    ipcRenderer.send('stop-task');
        setLogs(prev => [...prev, {
            text: "Stopping task...",
            timestamp: Date.now(),
            type: 'system'
        }]);
    };

  const handleExportChatHistory = async () => {
        try {
            const res: any = await (ipcRenderer as any).invoke?.('export-advanced-history');
            if (res?.canceled) return;
            if (res?.path) {
                setLogs(prev => [...prev, {
                    text: `Exported Advanced history (${res?.count ?? "?"} msgs): ${res.path}`,
                    timestamp: Date.now(),
                    type: 'system'
                }]);
            }
        } catch (e: any) {
            setLogs(prev => [...prev, {
                text: `Export failed: ${e?.message ?? e}`,
                timestamp: Date.now(),
                type: 'system'
            }]);
        }
    };

  return (
        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
            <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      
            <div className="flex-1 flex overflow-hidden min-h-0">
                {activeTab === 'chat' ? (
                    <>
                        {/* Chat should flex; Context View should take ~60% */}
                        <div className="flex-1 min-w-0">
                            <ChatInterface 
                                logs={logs}
                                instruction={instruction}
                                setInstruction={setInstruction}
                                isRunning={isRunning}
                                onStart={handleStart}
                                onStop={handleStop}
                            />
                        </div>
                        <div className="basis-[60%] shrink-0 min-w-0">
                            <ContextPanel
                                images={taskImages}
                                activeIndex={activeImageIndex}
                                onChangeIndex={setActiveImageIndex}
                                showNavigator={hasFinished && taskImages.length > 1}
                                canExportHistory={hasFinished && !isRunning}
                                onExportHistory={handleExportChatHistory}
                            />
                        </div>
                    </>
                ) : activeTab === 'settings' ? (
                    <SettingsPage settings={settings} onSave={updateSettings} />
                ) : (
                    <RulesPage settings={settings} onSave={updateSettings} />
                )}
      </div>
    </div>
  );
};

export default App;
