import { useState, useEffect } from 'react';
import { withAlpha } from '../utils/color';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Edit2, Download, Upload, Route } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import {
  nativeGetRoutingRules,
  nativeAddRoutingRule,
  nativeRemoveRoutingRule,
  nativeUpdateRoutingRule,
  nativeExportRoutingRules,
  nativeImportRoutingRules,
  RoutingRule,
} from '../native/bridge';

export default function RoutingRulesSettings() {
  const { isDark } = useTheme();
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    type: 'domain' as 'domain' | 'ip' | 'geoip' | 'custom',
    pattern: '',
    action: 'proxy' as 'proxy' | 'direct' | 'block',
    description: '',
    enabled: true,
  });

  const borderClass = isDark ? 'border-[#2a2a5a44]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-white' : 'text-[#0f172a]';
  const labelClass = isDark ? 'text-gray-500' : 'text-gray-400';

  // Fetch rules on mount
  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    try {
      const loadedRules = await nativeGetRoutingRules();
      setRules(loadedRules || []);
    } catch (e) {
      console.error('Failed to load routing rules:', e);
    }
  };

  const handleAddRule = async () => {
    if (!formData.pattern) return;

    setLoading(true);
    try {
      const newRule: RoutingRule = {
        id: editingRule?.id || `rule_${Date.now()}`,
        type: formData.type,
        pattern: formData.pattern,
        action: formData.action,
        description: formData.description,
        enabled: formData.enabled,
        createdAt: editingRule?.createdAt || Date.now(),
      };

      if (editingRule) {
        await nativeUpdateRoutingRule(newRule);
      } else {
        await nativeAddRoutingRule(newRule);
      }

      setFormData({ type: 'domain', pattern: '', action: 'proxy', description: '', enabled: true });
      setShowForm(false);
      setEditingRule(null);
      await loadRules();
    } finally {
      setLoading(false);
    }
  };

  const handleEditRule = (rule: RoutingRule) => {
    setEditingRule(rule);
    setFormData({
      type: rule.type,
      pattern: rule.pattern,
      action: rule.action,
      description: rule.description || '',
      enabled: rule.enabled,
    });
    setShowForm(true);
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Удалить правило?')) return;
    setLoading(true);
    try {
      await nativeRemoveRoutingRule(ruleId);
      await loadRules();
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      const exported = await nativeExportRoutingRules();
      const blob = new Blob([exported], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `routing-rules-${Date.now()}.json`;
      a.click();
    } catch (e) {
      console.error('Failed to export rules:', e);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await nativeImportRoutingRules(text);
      await loadRules();
    } catch (e) {
      console.error('Failed to import rules:', e);
    }
  };

  const getTypeLabel = (type: string): string => {
    const labels: Record<string, string> = { 'domain': 'Домен', 'ip': 'IP адрес', 'geoip': 'GeoIP', 'custom': 'Кастом' };
    return labels[type] || type;
  };

  const getActionColor = (action: string): string => {
    switch (action) {
      case 'proxy': return 'var(--accent)';
      case 'direct': return '#00ff88';
      case 'block': return '#ff0066';
      default: return '#888888';
    }
  };

  const getActionLabel = (action: string): string => {
    switch (action) {
      case 'proxy': return 'VPN';
      case 'direct': return 'DIRECT';
      case 'block': return 'BLOCK';
      default: return action.toUpperCase();
    }
  };

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-2 mb-3">
        <div className="flex items-center gap-2">
           <Route size={12} className="text-gray-500" />
           <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Свои правила</h3>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => { setShowForm(!showForm); setEditingRule(null); }}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-[#00ff88]"><Plus size={14} /></button>
          <button onClick={handleExport}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-[var(--accent)]"><Download size={14} /></button>
          <label className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors cursor-pointer text-[#ffe600]">
            <Upload size={14} /><input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
        </div>
      </div>

      {/* Form */}
      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className={`mb-4 mx-2 p-4 rounded-2xl border ${borderClass} bg-[#1a1a3a33] space-y-3 overflow-hidden`}>
            <div>
              <label className={`block text-[10px] uppercase font-bold ${labelClass} mb-1.5`}>Тип соответствия</label>
              <div className="flex flex-wrap gap-1.5">
                {(['domain', 'ip', 'geoip', 'custom'] as const).map(t => (
                   <button key={t} onClick={() => setFormData({ ...formData, type: t })}
                     className={`px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all border ${formData.type === t ? 'bg-[var(--accent-a15)] border-[var(--accent-a33)] text-[var(--accent)]' : 'bg-black/20 border-transparent text-gray-600'}`}>{getTypeLabel(t)}</button>
                ))}
              </div>
            </div>

            <div>
              <label className={`block text-[10px] uppercase font-bold ${labelClass} mb-1.5`}>Шаблон (Pattern)</label>
              <textarea value={formData.pattern} onChange={(e) => setFormData({ ...formData, pattern: e.target.value })}
                placeholder="google.com, *.ru, geoip:us..." rows={2}
                className={`w-full px-3 py-2.5 rounded-xl border ${borderClass} bg-black/30 text-xs font-mono ${textClass} focus:outline-none focus:border-[var(--accent-a33)]`} />
            </div>

            <div className="grid grid-cols-2 gap-3">
               <div className="flex-1">
                 <label className={`block text-[10px] uppercase font-bold ${labelClass} mb-1.5`}>Действие</label>
                 <select value={formData.action} onChange={(e) => setFormData({ ...formData, action: e.target.value as any })}
                   className={`w-full px-3 py-2 rounded-xl border ${borderClass} bg-black/30 text-[10px] font-bold ${textClass} focus:outline-none`}>
                   <option value="proxy">Через VPN</option>
                   <option value="direct">Напрямую</option>
                   <option value="block">Блокировать</option>
                 </select>
               </div>
               <div className="flex items-end pb-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData.enabled} onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-700 bg-black/50 text-[var(--accent)]" />
                    <span className={`text-[10px] font-bold ${labelClass}`}>Включено</span>
                  </label>
               </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={handleAddRule} disabled={loading} className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#00c4d6] text-black text-[10px] font-black uppercase tracking-widest">{editingRule ? 'Обновить' : 'Добавить'}</button>
              <button onClick={() => { setShowForm(false); setEditingRule(null); }} className="px-4 py-2.5 rounded-xl bg-gray-800 text-white text-[10px] font-black uppercase">Отмена</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      <div className="space-y-1.5 px-2 max-h-[300px] overflow-y-auto">
        {rules.length === 0 ? (
          <div className={`text-center py-6 ${labelClass} text-[10px] font-medium opacity-50 uppercase tracking-widest`}>Нет добавленных правил</div>
        ) : (
          rules.map((rule) => (
            <motion.div key={rule.id} layout
              className={`flex items-center gap-3 p-2.5 rounded-2xl border ${borderClass} ${isDark ? 'bg-white/[0.02]' : 'bg-black/[0.01]'} hover:bg-white/[0.05] transition-all`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-black tracking-tighter" style={{ backgroundColor: `${withAlpha(getActionColor(rule.action), '15')}`, color: getActionColor(rule.action), border: `1px solid ${withAlpha(getActionColor(rule.action), '33')}` }}>{getActionLabel(rule.action)}</span>
                  <span className={`text-[9px] font-bold ${labelClass} opacity-60 uppercase`}>{getTypeLabel(rule.type)}</span>
                  {!rule.enabled && <span className="text-[9px] text-red-500 font-black">OFF</span>}
                </div>
                <div className={`text-[11px] font-mono truncate ${textClass} opacity-80`}>{rule.pattern}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => handleEditRule(rule)} className="p-2 rounded-lg hover:bg-[#ffe60011] text-[#ffe600] transition-colors"><Edit2 size={12} /></button>
                <button onClick={() => handleDeleteRule(rule.id)} className="p-2 rounded-lg hover:bg-[#ff006611] text-[#ff0066] transition-colors"><Trash2 size={12} /></button>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}