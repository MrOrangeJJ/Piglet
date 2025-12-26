import ElectronStore from 'electron-store';

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
}

export interface AppConfig {
    advancedModel: ModelConfig;
    actionModel: ModelConfig;
    rules: RulePrompt[];
}

const DEFAULT_SETTINGS: AppConfig = {
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

export const store = new ElectronStore<AppConfig>({
    name: 'piglet-config',
    defaults: DEFAULT_SETTINGS
});

