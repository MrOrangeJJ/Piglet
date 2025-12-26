import { useState, useEffect } from 'react';
import { ipcRenderer } from 'electron';

export interface ModelConfig {
    baseUrl: string;
    apiKey: string;
    modelName: string;
}

export interface RulePrompt {
    id: string;
    name: string;
    content: string;
    enabled: boolean;
    injectToAdvanced: boolean;
    injectToAction: boolean;
}

export interface AppSettings {
    advancedModel: ModelConfig;
    actionModel: ModelConfig;
    rules: RulePrompt[];
}

const DEFAULT_SETTINGS: AppSettings = {
    advancedModel: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        modelName: "google/gemini-2.0-flash-exp:free"
    },
    actionModel: {
        baseUrl: "http://localhost:1234/v1/",
        apiKey: "lm-studio",
        modelName: "ui-tars-1.5-7b"
    },
    rules: []
};

export const useSettings = () => {
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

    useEffect(() => {
        // Load settings from main process
        ipcRenderer.invoke('get-settings').then((savedSettings) => {
            if (savedSettings) {
                const merged = { ...DEFAULT_SETTINGS, ...savedSettings } as AppSettings;
                // Normalize legacy rules (backward compatibility)
                merged.rules = (merged.rules || []).map((r: any) => ({
                    id: r.id,
                    name: r.name ?? 'Rule',
                    content: r.content ?? '',
                    enabled: !!r.enabled,
                    injectToAdvanced: r.injectToAdvanced ?? true,
                    injectToAction: r.injectToAction ?? false,
                }));
                setSettings(merged);
            }
        }).catch(err => console.error("Failed to load settings:", err));
    }, []);

    const updateSettings = (newSettings: AppSettings) => {
        setSettings(newSettings);
        // Save to main process
        ipcRenderer.send('save-settings', newSettings);
    };

    return { settings, updateSettings };
};
