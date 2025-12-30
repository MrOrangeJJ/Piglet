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
    /**
     * 新机制：
     * - enabled 控制是否启用该规则
     * - alwaysInject 控制是否永远注入到 Advanced（不参与动态匹配）
     */
    alwaysInject: boolean;
}

export interface AppConfig {
    advancedModel: ModelConfig;
    actionModel: ModelConfig;
    /**
     * Embeddings model：用于 rules 动态匹配（只给 Advanced 注入）
     * OpenAI-compatible embeddings endpoint
     */
    embeddingsModel: ModelConfig;
    /**
     * Executor / Tool Model：最终执行动作的模型（负责 tool calling）
     * 需要支持 function/tool calling
     */
    executorModel: ModelConfig;
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
    embeddingsModel: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        modelName: "openai/text-embedding-ada-002"
    },
    // 默认使用 Advanced 同源模型做 executor（更容易支持 tool calling）
    executorModel: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        modelName: "google/gemini-2.0-flash-exp:free"
    },
    rules: []
};

export const store = new ElectronStore<AppConfig>({
    name: 'piglet-config',
    defaults: DEFAULT_SETTINGS
});

