import React from 'react';
import { AppSettings } from '../hooks/useSettings';
import { Save } from 'lucide-react';

interface SettingsPageProps {
    settings: AppSettings;
    onSave: (settings: AppSettings) => void;
}

export const SettingsPage = ({ settings, onSave }: SettingsPageProps) => {
    const [localSettings, setLocalSettings] = React.useState(settings);

    const handleChange = (section: 'advancedModel' | 'actionModel', field: string, value: string) => {
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


