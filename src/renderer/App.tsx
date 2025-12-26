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
    const { settings, updateSettings } = useSettings();
    
  const [instruction, setInstruction] = useState('');
    const [logs, setLogs] = useState<LogItem[]>([]);
    const [latestImage, setLatestImage] = useState<string | undefined>(undefined);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    ipcRenderer.on('agent-thought', (_, payload: { text: string, image: string }) => {
            setLogs(prev => [...prev, { 
                text: payload.text, 
                image: payload.image, 
                timestamp: Date.now(), 
                type: 'thought' 
            }]);
            setLatestImage(payload.image);
    });
    
    ipcRenderer.on('agent-action-plan', (_, payload: { text: string, image: string }) => {
            setLogs(prev => [...prev, { 
                text: payload.text, 
                image: payload.image, 
                timestamp: Date.now(), 
                type: 'action' 
            }]);
            // Action plan usually shares the same image context or new one
            if (payload.image) setLatestImage(payload.image);
    });

    ipcRenderer.on('task-finished', () => {
        setIsRunning(false);
            setLogs(prev => [...prev, {
                text: "Task Finished",
                timestamp: Date.now(),
                type: 'system'
            }]);
        });
        
        ipcRenderer.on('task-error', (_, error: any) => {
            setIsRunning(false);
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

  const handleStart = () => {
        if (!instruction.trim()) return;
    setIsRunning(true);
        setLogs([{
            text: `Task Started: ${instruction}`,
            timestamp: Date.now(),
            type: 'system'
        }]);
        
        // Pass settings to backend
        ipcRenderer.send('start-task', { 
            instruction,
            config: settings
        });
  };

  const handleStop = () => {
        // Optimistic update
    setIsRunning(false);
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
                        <ChatInterface 
                            logs={logs}
                            instruction={instruction}
                            setInstruction={setInstruction}
                            isRunning={isRunning}
                            onStart={handleStart}
                            onStop={handleStop}
                        />
                        <ContextPanel latestImage={latestImage} />
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
