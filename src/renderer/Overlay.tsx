import React, { useEffect, useState } from 'react';
import { ipcRenderer } from 'electron';
import { StopCircle, Activity, Loader2 } from 'lucide-react';
import './styles/overlay.css';

const Overlay = () => {
  const [markers, setMarkers] = useState<any[]>([]);
  const [showWidget, setShowWidget] = useState(false);
  const [currentAction, setCurrentAction] = useState<string>("Processing...");
  const [actionHistory, setActionHistory] = useState<string[]>([]);

  useEffect(() => {
    ipcRenderer.on('draw-highlight', (_, payload) => {
      const id = Date.now();
      setMarkers(prev => [...prev, { ...payload, id }]);
      
      let newAction = "";
      if (payload.type === 'type') newAction = `Typing: ${payload.text}`;
      else if (payload.type === 'click') newAction = 'Clicking...';
      else if (payload.type === 'drag') newAction = 'Dragging...';
      else if (payload.type === 'scroll') newAction = `Scrolling ${payload.text}`;
      else if (payload.type === 'wait') newAction = 'Waiting...';
      else if (payload.text) newAction = payload.text;

      if (newAction) {
          setCurrentAction(newAction);
          // Add to history if unique or meaningful
          setActionHistory(prev => {
              const newHist = [...prev, newAction].slice(-3); // Keep last 3
              return newHist;
          });
      }
      
      setTimeout(() => {
        setMarkers(prev => prev.filter(m => m.id !== id));
      }, 2000); 
    });

    ipcRenderer.on('show-widget', (_, payload) => {
        setShowWidget(payload.visible);
        if (payload.text) setCurrentAction(payload.text);
        // If widget is hidden while mouse is hovering, mouseleave won't fire.
        // Force overlay back to click-through to avoid intercepting all clicks.
        if (!payload.visible) {
            ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
        }
    });

    ipcRenderer.on('agent-thought', (_, payload) => {
        setCurrentAction("Thinking...");
    });
    
    ipcRenderer.on('agent-action-plan', (_, payload) => {
        // Parse action plan to be more readable if needed
        const actionMatch = payload.text.match(/^Action:\s*([a-z_]+)/);
        const actionType = actionMatch ? actionMatch[1] : "Executing Action...";
        setCurrentAction(`Plan: ${actionType}`);
    });
    
    return () => {
        ipcRenderer.removeAllListeners('draw-highlight');
        ipcRenderer.removeAllListeners('show-widget');
        ipcRenderer.removeAllListeners('agent-thought');
        ipcRenderer.removeAllListeners('agent-action-plan');
    };
  }, []);

  const handleMouseEnter = () => {
      ipcRenderer.send('set-ignore-mouse-events', false);
  };

  const handleMouseLeave = () => {
      ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
  };

  const handleStop = () => {
      ipcRenderer.send('stop-task');
  };

  return (
    <div style={{ width: '100vw', height: '100vh', pointerEvents: 'none', overflow: 'hidden', position: 'relative' }}>
      {/* SVG Layer for lines/arrows */}
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 9998 }}>
        <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#Eab308" />
            </marker>
        </defs>
        {markers.map(m => {
            if (m.type === 'drag' && m.startX && m.startY && m.endX && m.endY) {
                return (
                    <line 
                        key={`line-${m.id}`}
                        x1={m.startX} y1={m.startY} 
                        x2={m.endX} y2={m.endY} 
                        stroke="#Eab308" 
                        strokeWidth="4" 
                        markerEnd="url(#arrowhead)"
                        style={{ filter: 'drop-shadow(0px 0px 3px rgba(0,0,0,0.5))', opacity: 0.8 }}
                    />
                );
            }
            return null;
        })}
      </svg>

      {/* HTML Layer for markers and text */}
      {markers.map(m => {
          if (['click', 'double_click', 'right_click', 'left_single', 'left_click', 'middle_click'].includes(m.type)) {
              let color = 'red';
              if (m.type.includes('right')) color = 'blue';
              if (m.type.includes('middle')) color = 'green';
              
              return (
                <div 
                    key={m.id}
                    className="click-marker"
                    style={{ 
                        position: 'absolute', 
                        left: (m.x || 0) - 20, 
                        top: (m.y || 0) - 20,
                        width: 40, 
                        height: 40, 
                        borderRadius: '50%', 
                        border: `3px solid ${color}`,
                        backgroundColor: `rgba(${color === 'red' ? '255,0,0' : color === 'blue' ? '0,0,255' : '0,255,0'}, 0.2)`,
                        boxShadow: '0 0 10px rgba(0,0,0,0.5)',
                        animation: 'ping 1s cubic-bezier(0, 0, 0.2, 1) infinite'
                    }} 
                />
              );
          } else if (m.type === 'drag') {
               return (
                   <div 
                        key={`drag-start-${m.id}`}
                        style={{
                            position: 'absolute',
                            left: (m.startX || 0) - 10,
                            top: (m.startY || 0) - 10,
                            width: 20, 
                            height: 20, 
                            borderRadius: '50%', 
                            backgroundColor: '#Eab308',
                            border: '2px solid white',
                            boxShadow: '0 0 5px black'
                        }}
                   />
               );
          } else if (['type', 'hotkey', 'scroll', 'wait', 'hover'].includes(m.type)) {
              let text = "";
              if (m.type === 'type') text = `⌨️ Typing: "${m.text}"`;
              if (m.type === 'hotkey') text = `⌨️ Hotkey: ${m.text}`;
              if (m.type === 'scroll') text = `🖱️ Scroll: ${m.text}`;
              if (m.type === 'wait') text = `⏳ Waiting...`;
              if (m.type === 'hover') text = `👀 Hovering`;

              return (
                  <div
                    key={m.id}
                    style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: '150px',
                        transform: 'translateX(-50%)',
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        color: 'white',
                        padding: '12px 24px',
                        borderRadius: '12px',
                        fontSize: '20px',
                        fontWeight: '600',
                        zIndex: 9999,
                        animation: 'fadeInOut 2s ease-in-out forwards',
                        whiteSpace: 'pre-wrap',
                        maxWidth: '80%',
                        textAlign: 'center',
                        backdropFilter: 'blur(4px)',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
                    }}
                  >
                      {text}
                  </div>
              );
          }
          return null;
      })}

      {/* Floating Control Widget */}
      {showWidget && (
          <div 
            style={{
                position: 'absolute',
                bottom: 100,
                right: 20,
                pointerEvents: 'auto', // Override parent's none
                zIndex: 10000
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
              <div className="flex items-center gap-3 bg-black/80 backdrop-blur-md border border-white/20 p-4 rounded-2xl shadow-2xl text-white">
                    <div className="relative">
                        <div className="absolute inset-0 bg-green-500 rounded-full animate-ping opacity-75"></div>
                        <Activity size={24} className="relative text-green-500" />
                    </div>
                    <div className="flex flex-col min-w-[150px]">
                        <span className="font-bold text-sm text-green-400 mb-1">Agent Running</span>
                        
                        {/* History (Faded) */}
                        <div className="flex flex-col space-y-1 mb-1">
                             {actionHistory.slice(0, -1).map((hist, i) => (
                                 <span key={i} className="text-[10px] text-white/40 truncate max-w-[200px]">{hist}</span>
                             ))}
                        </div>

                        {/* Current Action */}
                        <span className="text-xs text-white font-medium max-w-[200px] truncate">
                            {currentAction}
                        </span>
                    </div>
                    <div className="h-8 w-[1px] bg-white/20 mx-1"></div>
                    <button 
                        onClick={handleStop}
                        className="flex items-center gap-2 bg-red-500/20 hover:bg-red-500/40 text-red-500 px-3 py-2 rounded-lg transition-colors border border-red-500/50"
                    >
                        <StopCircle size={18} />
                        <span className="text-sm font-medium">Stop</span>
                    </button>
              </div>
          </div>
      )}
    </div>
  );
};

export default Overlay;
