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
    ipcRenderer.on('agent-thought', (_, payload: { text: string, image: string }) => {
            setLogs(prev => [...prev, { 
                text: payload.text, 
                image: payload.image, 
                timestamp: Date.now(), 
                type: 'thought' 
            }]);
            pushTaskImage(payload.image);
    });
    
    ipcRenderer.on('agent-action-plan', (_, payload: { text: string, image: string }) => {
            setLogs(prev => [...prev, { 
                text: payload.text, 
                image: payload.image, 
                timestamp: Date.now(), 
                type: 'action' 
            }]);
            // Keep all screenshots for this task.
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

  return (
        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
            <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      
            <div className="flex-1 flex overflow-hidden">
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
