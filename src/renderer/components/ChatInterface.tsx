import React, { useRef, useEffect } from 'react';
import { Send, StopCircle, Brain, Zap, Terminal } from 'lucide-react';
import { cn } from '../lib/utils';

export interface LogItem {
    text: string;
    image?: string;
    timestamp: number;
    type: 'thought' | 'action' | 'system';
}

interface ChatInterfaceProps {
    logs: LogItem[];
    instruction: string;
    setInstruction: (val: string) => void;
    isRunning: boolean;
    onStart: () => void;
    onStop: () => void;
}

export const ChatInterface = ({ 
    logs, 
    instruction, 
    setInstruction, 
    isRunning, 
    onStart, 
    onStop 
}: ChatInterfaceProps) => {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isRunning && instruction.trim()) {
                onStart();
            }
        }
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-background relative">
            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
                {logs.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                        <Terminal size={64} className="mb-4" />
                        <p className="text-lg">Ready to accept instructions...</p>
                    </div>
                )}
                
                {logs.map((log, i) => (
                    <div key={i} className={cn(
                        "flex gap-3 p-4 rounded-lg border text-sm max-w-3xl",
                        log.type === 'thought' ? "bg-blue-50/50 border-blue-100 dark:bg-blue-950/20 dark:border-blue-900" : 
                        log.type === 'action' ? "bg-green-50/50 border-green-100 dark:bg-green-950/20 dark:border-green-900" :
                        "bg-gray-50 border-gray-100 dark:bg-gray-800 dark:border-gray-700"
                    )}>
                        <div className="mt-1 flex-shrink-0">
                            {log.type === 'thought' && <Brain size={18} className="text-blue-500" />}
                            {log.type === 'action' && <Zap size={18} className="text-green-500" />}
                            {log.type === 'system' && <Terminal size={18} className="text-gray-500" />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="font-semibold text-xs uppercase tracking-wider opacity-70">
                                    {log.type === 'thought' ? 'Advanced Model' : log.type === 'action' ? 'Action Model' : 'System'}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {new Date(log.timestamp).toLocaleTimeString()}
                                </span>
                            </div>
                            <div className="whitespace-pre-wrap font-mono leading-relaxed break-words">
                                {log.text}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Input Area */}
            <div className="p-4 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                <div className="max-w-3xl mx-auto relative flex gap-2">
                    <div className="relative flex-1">
                        <textarea
                            value={instruction}
                            onChange={(e) => setInstruction(e.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={isRunning}
                            placeholder="Type your instruction here (e.g. 'Open Calendar and add a meeting')..."
                            className="w-full min-h-[50px] max-h-[200px] p-3 pr-12 rounded-xl border border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none shadow-sm"
                            rows={1}
                            style={{ height: 'auto', minHeight: '52px' }}
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
                             {!isRunning ? (
                                <button 
                                    onClick={onStart}
                                    disabled={!instruction.trim()}
                                    className="p-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center h-full"
                                >
                                    <Send size={18} />
                                </button>
                             ) : (
                                <button 
                                    onClick={onStop}
                                    className="p-2 bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-colors animate-pulse flex items-center justify-center h-full"
                                >
                                    <StopCircle size={18} />
                                </button>
                             )}
                        </div>
                    </div>
                </div>
                <div className="text-center mt-2 text-xs text-muted-foreground">
                    Model: UI-TARS (Dual-Agent Mode)
                </div>
            </div>
        </div>
    );
};


