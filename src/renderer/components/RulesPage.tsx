import React, { useMemo, useState } from 'react';
import { ipcRenderer } from 'electron';
import { Check, CheckCircle2, Circle, FileJson2, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
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
  alwaysInject: false,
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

  const IconToggle = (props: {
    pressed: boolean;
    onPressedChange: (next: boolean) => void;
    label: string;
    iconOn: React.ReactNode;
    iconOff: React.ReactNode;
    intent?: 'primary' | 'success';
  }) => {
    const { pressed, onPressedChange, label, iconOn, iconOff, intent = 'primary' } = props;
    const onClasses =
      intent === 'success'
        ? 'bg-emerald-600 text-white border-emerald-600/40 hover:bg-emerald-600/90'
        : 'bg-primary text-primary-foreground border-primary/40 hover:bg-primary/90';
    return (
      <button
        type="button"
        aria-pressed={pressed}
        title={label}
        onClick={() => onPressedChange(!pressed)}
        className={[
          'inline-flex items-center justify-center h-9 w-9 rounded-lg border transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          pressed ? onClasses : 'bg-background text-muted-foreground border-border hover:bg-muted',
        ].join(' ')}
      >
        <span className="sr-only">{label}</span>
        {pressed ? iconOn : iconOff}
      </button>
    );
  };

  return (
    <div className="flex-1 min-h-0 p-8 overflow-y-auto overscroll-y-contain bg-background h-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Rule List</h1>

        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              try {
                await ipcRenderer.invoke('open-rules-json');
              } catch (e) {
                console.error('Failed to open rules.json', e);
              }
            }}
            className="flex items-center gap-2 border border-border bg-background px-4 py-2 rounded-md hover:bg-muted transition-colors"
            title="Open rules.json in your system default editor"
          >
            <FileJson2 size={18} />
            Open rules.json
          </button>
          <button
            onClick={addRule}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 transition-colors"
          >
            <Plus size={18} />
            Add Rule
          </button>
        </div>
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
            className="bg-card p-4 rounded-xl border border-border shadow-sm hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3">
              {/* Enable (icon toggle) */}
              <div className="pt-0.5">
                <IconToggle
                  pressed={!!rule.enabled}
                  onPressedChange={(next) => updateRule(rule.id, { enabled: next })}
                  label={rule.enabled ? 'Enabled' : 'Disabled'}
                  intent="success"
                  iconOn={<CheckCircle2 size={18} />}
                  iconOff={<Circle size={18} />}
                />
              </div>

              <div className="flex-1 min-w-0">
                {/* Header row */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    {editingId === rule.id ? (
                      <input
                        className="font-semibold text-base bg-background border border-input rounded-lg px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="Rule name"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-base truncate">{rule.name}</div>
                        {!rule.enabled && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground">
                            disabled
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Always inject (icon toggle) */}
                  <IconToggle
                    pressed={!!rule.alwaysInject}
                    onPressedChange={(next) => updateRule(rule.id, { alwaysInject: next })}
                    label={rule.alwaysInject ? 'Always inject (Advanced)' : 'Dynamic match (Advanced)'}
                    iconOn={<Pin size={18} />}
                    iconOff={<PinOff size={18} />}
                  />

                  {/* Actions */}
                  {editingId === rule.id ? (
                    <>
                      <button
                        onClick={commitEdit}
                        className="p-2 rounded-lg border border-border hover:bg-muted transition-colors"
                        title="Save & Lock"
                      >
                        <Check size={16} />
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="p-2 rounded-lg border border-border hover:bg-muted transition-colors"
                        title="Cancel"
                      >
                        <X size={16} />
                      </button>
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="p-2 rounded-lg border border-border hover:bg-muted transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => startEdit(rule.id)}
                      className="p-2 rounded-lg border border-border hover:bg-muted transition-colors"
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
                      className="w-full min-h-[120px] p-3 rounded-lg border border-input bg-background font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      placeholder="Enter the prompt rule to inject..."
                    />
                  ) : (
                    <div className="w-full rounded-lg bg-muted/30 p-3">
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


