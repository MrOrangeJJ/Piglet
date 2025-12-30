import React from 'react';
import { AppSettings } from '../hooks/useSettings';
import { Save } from 'lucide-react';

interface SettingsPageProps {
    settings: AppSettings;
    onSave: (settings: AppSettings) => void;
}

export const SettingsPage = ({ settings, onSave }: SettingsPageProps) => {
    const [localSettings, setLocalSettings] = React.useState(settings);

    const handleChange = (
        section: 'advancedModel' | 'actionModel' | 'embeddingsModel' | 'executorModel',
        field: string,
        value: string
    ) => {
        setLocalSettings(prev => ({
            ...prev,
            [section]: {
                ...prev[section],
                [field]: value
            }
        }));
    };

    const handleSave = () => {
        onSave(localSettings);
        alert('Settings Saved!');
    };

    return (
        <div className="flex-1 p-8 overflow-y-auto bg-background h-full">
            <h1 className="text-2xl font-bold mb-6">Settings</h1>
            
            <div className="space-y-8 max-w-2xl">
                {/* Advanced Model Settings */}
                <div className="bg-card p-6 rounded-lg border border-border shadow-sm">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        🧠 Advanced Model (The Brain)
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-1">Base URL</label>
                            <input 
                                type="text" 
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.advancedModel.baseUrl}
                                onChange={e => handleChange('advancedModel', 'baseUrl', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">API Key</label>
                            <input 
                                type="password" 
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.advancedModel.apiKey}
                                onChange={e => handleChange('advancedModel', 'apiKey', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Model Name</label>
                            <input 
                                type="text" 
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.advancedModel.modelName}
                                onChange={e => handleChange('advancedModel', 'modelName', e.target.value)}
                            />
                        </div>
                    </div>
                </div>

                {/* Action Model Settings */}
                <div className="bg-card p-6 rounded-lg border border-border shadow-sm">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        ⚡ Action Model (The Hands)
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-1">Base URL</label>
                            <input 
                                type="text" 
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.actionModel.baseUrl}
                                onChange={e => handleChange('actionModel', 'baseUrl', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">API Key</label>
                            <input 
                                type="password" 
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.actionModel.apiKey}
                                onChange={e => handleChange('actionModel', 'apiKey', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Model Name</label>
                            <input 
                                type="text" 
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.actionModel.modelName}
                                onChange={e => handleChange('actionModel', 'modelName', e.target.value)}
                            />
                        </div>
                    </div>
                </div>

                {/* Embeddings Model Settings */}
                <div className="bg-card p-6 rounded-lg border border-border shadow-sm">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        🧩 Embeddings Model (Rules Matcher)
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-1">Base URL</label>
                            <input
                                type="text"
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.embeddingsModel.baseUrl}
                                onChange={e => handleChange('embeddingsModel', 'baseUrl', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">API Key</label>
                            <input
                                type="password"
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.embeddingsModel.apiKey}
                                onChange={e => handleChange('embeddingsModel', 'apiKey', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Model Name</label>
                            <input
                                type="text"
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.embeddingsModel.modelName}
                                onChange={e => handleChange('embeddingsModel', 'modelName', e.target.value)}
                            />
                        </div>
                        <div className="text-xs text-muted-foreground">
                            Used for dynamic rule matching. Rules are injected ONLY into Advanced model.
                        </div>
                    </div>
                </div>

                {/* Executor / Tool Model Settings */}
                <div className="bg-card p-6 rounded-lg border border-border shadow-sm">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        🛠️ Executor / Tool Model (Final Action Runner)
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-1">Base URL</label>
                            <input
                                type="text"
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.executorModel.baseUrl}
                                onChange={e => handleChange('executorModel', 'baseUrl', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">API Key</label>
                            <input
                                type="password"
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.executorModel.apiKey}
                                onChange={e => handleChange('executorModel', 'apiKey', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Model Name</label>
                            <input
                                type="text"
                                className="w-full p-2 rounded-md border border-input bg-background"
                                value={localSettings.executorModel.modelName}
                                onChange={e => handleChange('executorModel', 'modelName', e.target.value)}
                            />
                        </div>
                        <div className="text-xs text-muted-foreground">
                            This model must support tool/function calling. It converts the planned action into exactly one tool call.
                        </div>
                    </div>
                </div>

                <button 
                    onClick={handleSave}
                    className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-2 rounded-md hover:bg-primary/90 transition-colors"
                >
                    <Save size={18} />
                    Save Settings
                </button>
            </div>
        </div>
    );
};


