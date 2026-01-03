import React from 'react';
import { ChevronLeft, ChevronRight, Image as ImageIcon, Monitor, Download } from 'lucide-react';

interface ContextPanelProps {
    images: string[];
    activeIndex: number;
    onChangeIndex: (next: number) => void;
    showNavigator?: boolean;
    canExportHistory?: boolean;
    onExportHistory?: () => void;
}

export const ContextPanel = ({
    images,
    activeIndex,
    onChangeIndex,
    showNavigator,
    canExportHistory,
    onExportHistory,
}: ContextPanelProps) => {
    const hasAny = images.length > 0 && activeIndex >= 0 && activeIndex < images.length;
    const img = hasAny ? images[activeIndex] : undefined;
    const canPrev = activeIndex > 0;
    const canNext = activeIndex >= 0 && activeIndex < images.length - 1;

    return (
        <div className="w-full border-l border-border bg-muted/30 flex flex-col h-full">
            <div className="p-4 border-b border-border bg-background flex items-center gap-2">
                <Monitor size={18} className="text-muted-foreground" />
                <h3 className="font-semibold text-sm">Context View</h3>
                <div className="ml-auto flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onExportHistory}
                        disabled={!canExportHistory}
                        className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Export Chat History"
                        aria-label="Export Chat History"
                    >
                        <Download size={16} />
                    </button>
                </div>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto">
                {img ? (
                    <div className="w-full flex flex-col items-center">
                        <div className="w-full rounded-lg overflow-hidden border border-border shadow-sm bg-background">
                            <img src={img} alt="Screen Context" className="w-full h-auto" />
                        </div>

                        {showNavigator ? (
                            <div className="mt-3 w-full flex items-center justify-center gap-3">
                                <button
                                    type="button"
                                    className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    onClick={() => canPrev && onChangeIndex(activeIndex - 1)}
                                    disabled={!canPrev}
                                    title="Previous screenshot"
                                >
                                    <ChevronLeft size={18} />
                                </button>
                                <div className="text-xs text-muted-foreground tabular-nums">
                                    {activeIndex + 1} / {images.length}
                                </div>
                                <button
                                    type="button"
                                    className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    onClick={() => canNext && onChangeIndex(activeIndex + 1)}
                                    disabled={!canNext}
                                    title="Next screenshot"
                                >
                                    <ChevronRight size={18} />
                                </button>
                            </div>
                        ) : (
                            <div className="mt-2 text-xs text-muted-foreground text-center">
                                Latest Screenshot
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="h-[320px] w-full flex flex-col items-center justify-center text-muted-foreground border-2 border-dashed border-border rounded-lg bg-muted/10">
                        <ImageIcon size={48} className="mb-2 opacity-50" />
                        <span className="text-sm">No context available</span>
                    </div>
                )}
                
                <div className="mt-6 space-y-4">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                        Active State
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                        <div className="bg-background p-3 rounded-md border border-border">
                            <div className="text-xs text-muted-foreground mb-1">Status</div>
                            <div className="font-medium text-sm text-green-600 flex items-center gap-1">
                                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                Ready
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};


