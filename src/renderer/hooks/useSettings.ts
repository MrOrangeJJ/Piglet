import { useState, useEffect, useCallback } from 'react';
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
    alwaysInject: boolean;
}

export interface AppSettings {
    advancedModel: ModelConfig;
    actionModel: ModelConfig;
    embeddingsModel: ModelConfig;
    executorModel: ModelConfig;
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
    embeddingsModel: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        modelName: "openai/text-embedding-ada-002"
    },
    executorModel: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        modelName: "google/gemini-2.0-flash-exp:free"
    },
    rules: []
};

export const useSettings = () => {
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

    const mergeAndNormalize = useCallback((savedSettings: any): AppSettings => {
        const merged = {
            ...DEFAULT_SETTINGS,
            ...savedSettings,
            advancedModel: { ...DEFAULT_SETTINGS.advancedModel, ...(savedSettings as any)?.advancedModel },
            actionModel: { ...DEFAULT_SETTINGS.actionModel, ...(savedSettings as any)?.actionModel },
            embeddingsModel: { ...DEFAULT_SETTINGS.embeddingsModel, ...(savedSettings as any)?.embeddingsModel },
            executorModel: { ...DEFAULT_SETTINGS.executorModel, ...(savedSettings as any)?.executorModel },
        } as AppSettings;

        // No legacy compatibility: rules must already be in the new format.
        merged.rules = (merged.rules || []).map((r: any) => ({
            id: String(r.id),
            name: String(r.name ?? 'Rule'),
            content: String(r.content ?? ''),
            enabled: !!r.enabled,
            alwaysInject: !!r.alwaysInject,
        }));
        return merged;
    }, []);

    useEffect(() => {
        // Load settings from main process
        ipcRenderer.invoke('get-settings').then((savedSettings) => {
            if (savedSettings) {
                setSettings(mergeAndNormalize(savedSettings));
            }
        }).catch(err => console.error("Failed to load settings:", err));
    }, [mergeAndNormalize]);

    const refreshSettings = useCallback(async () => {
        const savedSettings = await ipcRenderer.invoke('get-settings');
        if (savedSettings) setSettings(mergeAndNormalize(savedSettings));
    }, [mergeAndNormalize]);

    const updateSettings = useCallback((newSettings: AppSettings) => {
        setSettings(newSettings);
        // Save to main process
        ipcRenderer.send('save-settings', newSettings);
    }, []);

    return { settings, updateSettings, refreshSettings };
};
