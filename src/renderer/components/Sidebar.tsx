import React from 'react';
import { MessageSquare, Settings2, ListChecks } from 'lucide-react';
import { cn } from '../lib/utils';

interface SidebarProps {
    activeTab: 'chat' | 'settings' | 'rules';
    onTabChange: (tab: 'chat' | 'settings' | 'rules') => void;
}

export const Sidebar = ({ activeTab, onTabChange }: SidebarProps) => {
    return (
        <div className="w-16 flex flex-col items-center py-4 bg-muted border-r border-border h-full">
            <div className="mb-6">
                <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold text-xl">
                    PG
                </div>
            </div>
            
            <button 
                onClick={() => onTabChange('chat')}
                className={cn(
                    "p-3 rounded-lg mb-2 transition-colors",
                    activeTab === 'chat' ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:bg-background/50"
                )}
            >
                <MessageSquare size={24} />
            </button>
            
            <button 
                onClick={() => onTabChange('settings')}
                className={cn(
                    "p-3 rounded-lg mb-2 transition-colors",
                    activeTab === 'settings' ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:bg-background/50"
                )}
            >
                <Settings2 size={24} />
            </button>

            <button 
                onClick={() => onTabChange('rules')}
                className={cn(
                    "p-3 rounded-lg mb-2 transition-colors",
                    activeTab === 'rules' ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:bg-background/50"
                )}
            >
                <ListChecks size={24} />
            </button>
        </div>
    );
};


