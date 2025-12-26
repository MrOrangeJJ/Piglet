import React from 'react';
import { Monitor, Image as ImageIcon } from 'lucide-react';

interface ContextPanelProps {
    latestImage?: string;
}

export const ContextPanel = ({ latestImage }: ContextPanelProps) => {
    return (
        <div className="w-[400px] border-l border-border bg-muted/30 flex flex-col h-full">
            <div className="p-4 border-b border-border bg-background flex items-center gap-2">
                <Monitor size={18} className="text-muted-foreground" />
                <h3 className="font-semibold text-sm">Context View</h3>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto">
                {latestImage ? (
                    <div className="rounded-lg overflow-hidden border border-border shadow-sm bg-background">
                        <img src={latestImage} alt="Latest Screen Context" className="w-full h-auto" />
                        <div className="p-2 text-xs text-muted-foreground border-t border-border bg-muted/50 text-center">
                            Latest Screenshot
                        </div>
                    </div>
                ) : (
                    <div className="h-64 flex flex-col items-center justify-center text-muted-foreground border-2 border-dashed border-border rounded-lg bg-muted/10">
                        <ImageIcon size={48} className="mb-2 opacity-50" />
                        <span className="text-sm">No context available</span>
                    </div>
                )}
                
                <div className="mt-6 space-y-4">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                        Active State
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="bg-background p-3 rounded-md border border-border">
                            <div className="text-xs text-muted-foreground mb-1">Status</div>
                            <div className="font-medium text-sm text-green-600 flex items-center gap-1">
                                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                Ready
                            </div>
                        </div>
                        <div className="bg-background p-3 rounded-md border border-border">
                            <div className="text-xs text-muted-foreground mb-1">Mode</div>
                            <div className="font-medium text-sm">Dual Agent</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};


