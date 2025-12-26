import React, { useMemo, useState } from 'react';
import { Brain, Check, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import type { AppSettings, RulePrompt } from '../hooks/useSettings';

interface RulesPageProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

const newRule = (): RulePrompt => ({
  id: crypto.randomUUID(),
  name: 'New Rule',
  content: '',
  enabled: true,
  injectToAdvanced: true,
  injectToAction: false,
});

export const RulesPage = ({ settings, onSave }: RulesPageProps) => {
  const rules = settings.rules ?? [];
  const rulesById = useMemo(() => {
    const map = new Map<string, RulePrompt>();
    rules.forEach((r) => map.set(r.id, r));
    return map;
  }, [rules]);

  // Editing state: keep drafts locally, only persist on "✓"
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  const [draftContent, setDraftContent] = useState<string>('');

  const updateRule = (id: string, patch: Partial<RulePrompt>) => {
    const next = rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    onSave({ ...settings, rules: next });
  };

  const addRule = () => {
    onSave({ ...settings, rules: [...rules, newRule()] });
  };

  const deleteRule = (id: string) => {
    onSave({ ...settings, rules: rules.filter((r) => r.id !== id) });
  };

  const startEdit = (id: string) => {
    const r = rulesById.get(id);
    if (!r) return;
    setEditingId(id);
    setDraftName(r.name ?? '');
    setDraftContent(r.content ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftName('');
    setDraftContent('');
  };

  const commitEdit = () => {
    if (!editingId) return;
    updateRule(editingId, {
      name: draftName,
      content: draftContent,
    });
    cancelEdit();
  };

  return (
    <div className="flex-1 p-8 overflow-y-auto bg-background h-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Rule List</h1>

        </div>
        <button
          onClick={addRule}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus size={18} />
          Add Rule
        </button>
      </div>

      <div className="space-y-3 w-full max-w-6xl">
        {rules.length === 0 && (
          <div className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-6">
            No rules yet. Click the + button to add a new rule.
          </div>
        )}

        {rules.map((rule) => (
          <div
            key={rule.id}
            className="bg-card p-4 rounded-xl border border-border shadow-sm"
          >
            <div className="flex items-start gap-3">
              {/* Enable */}
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={!!rule.enabled}
                onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                title="Enable / Disable"
              />

              <div className="flex-1 min-w-0">
                {/* Header row */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    {editingId === rule.id ? (
                      <input
                        className="font-semibold text-sm bg-background border border-input rounded-md px-2 py-1 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="Rule name"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-sm truncate">{rule.name}</div>
                        {!rule.enabled && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground">
                            disabled
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Inject toggles */}
                  <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
                    <button
                      type="button"
                      onClick={() =>
                        updateRule(rule.id, { injectToAdvanced: !rule.injectToAdvanced })
                      }
                      className={[
                        'h-8 w-8 rounded-md flex items-center justify-center transition-colors',
                        rule.injectToAdvanced
                          ? 'bg-background text-blue-600 shadow-sm'
                          : 'text-muted-foreground hover:bg-background/60',
                      ].join(' ')}
                      title="Inject to Advanced (Brain)"
                      aria-label="Inject to Advanced"
                    >
                      <Brain size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateRule(rule.id, { injectToAction: !rule.injectToAction })
                      }
                      className={[
                        'h-8 w-8 rounded-md flex items-center justify-center transition-colors',
                        rule.injectToAction
                          ? 'bg-background text-amber-600 shadow-sm'
                          : 'text-muted-foreground hover:bg-background/60',
                      ].join(' ')}
                      title="Inject to Action (Hands)"
                      aria-label="Inject to Action"
                    >
                      <Zap size={16} />
                    </button>
                  </div>

                  {/* Actions */}
                  {editingId === rule.id ? (
                    <>
                      <button
                        onClick={commitEdit}
                        className="p-2 rounded-md border border-border hover:bg-muted transition-colors"
                        title="Save & Lock"
                      >
                        <Check size={16} />
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="p-2 rounded-md border border-border hover:bg-muted transition-colors"
                        title="Cancel"
                      >
                        <X size={16} />
                      </button>
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="p-2 rounded-md border border-border hover:bg-muted transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => startEdit(rule.id)}
                      className="p-2 rounded-md border border-border hover:bg-muted transition-colors"
                      title="Edit"
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                </div>

                {/* Body */}
                <div className="mt-3">
                  {editingId === rule.id ? (
                    <textarea
                      className="w-full min-h-[110px] p-3 rounded-md border border-input bg-background font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      placeholder="Enter the prompt rule to inject..."
                    />
                  ) : (
                    <div className="w-full rounded-lg bg-muted/20 p-3">
                      <pre className="whitespace-pre-wrap text-sm font-mono text-foreground/90 leading-relaxed">
                        {rule.content?.trim()
                          ? rule.content
                          : '— empty — (click ✏️ to edit)'}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};


