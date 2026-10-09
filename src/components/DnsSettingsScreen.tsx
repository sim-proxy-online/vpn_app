import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Globe, Plus, Trash2,
  Settings2, Zap, Server, Database
} from 'lucide-react';
import { useTheme } from '../ThemeContext';

interface DnsServer {
  id: string;
  name: string;
  address: string;
  domains?: string[]; // Domains to resolve via this server
  expectIPs?: string[]; // Discard result if not matching these IPs
  skipFallback?: boolean;
  enabled: boolean;
}

interface DnsHost {
  id: string;
  domain: string;
  ip: string;
}

export default function DnsSettingsScreen({ onBack }: { onBack: () => void }) {
  const { isDark } = useTheme();

  // States
  const [dnsServers, setDnsServers] = useState<DnsServer[]>([]);
  const [dnsHosts, setDnsHosts] = useState<DnsHost[]>([]);
  const [fakeDns, setFakeDns] = useState(false);
  const [domainStrategy, setDomainStrategy] = useState('IPIfNonMatch');
  const [queryStrategy, setQueryStrategy] = useState('UseIPv4');

  // UI States
  const [showServerForm, setShowServerForm] = useState(false);
  const [editingServer, setEditingServer] = useState<DnsServer | null>(null);
  const [showHostForm, setShowHostForm] = useState(false);
  const [editingHost, setEditingHost] = useState<DnsHost | null>(null);

  // Persistence
  useEffect(() => {
    const load = (key: string, fb: any) => {
      try {
        const s = localStorage.getItem(key);
        return s ? JSON.parse(s) : fb;
      } catch { return fb; }
    };

    setDnsServers(load('sim-dns-servers', [
      { id: 'cf', name: 'Cloudflare', address: 'https://1.1.1.1/dns-query', enabled: true },
      { id: 'google', name: 'Google', address: '8.8.8.8', enabled: true }
    ]));
    setDnsHosts(load('sim-dns-hosts', []));
    setFakeDns(load('sim-fakedns', false));
    setDomainStrategy(load('sim-domain-strategy', 'IPIfNonMatch'));
    setQueryStrategy(load('sim-dns-query-strategy', 'UseIPv4'));
  }, []);

  const save = (key: string, data: any) => {
    localStorage.setItem(key, JSON.stringify(data));
  };

  // Handlers
  const handleSaveServer = (server: Partial<DnsServer>) => {
    let newServers: DnsServer[];
    if (editingServer) {
      newServers = dnsServers.map(s => s.id === editingServer.id ? { ...s, ...server } as DnsServer : s);
    } else {
      const newSrv: DnsServer = {
        id: Math.random().toString(36).substr(2, 9),
        name: server.name || 'DNS Server',
        address: server.address || '',
        domains: server.domains,
        expectIPs: server.expectIPs,
        skipFallback: server.skipFallback,
        enabled: true
      };
      newServers = [...dnsServers, newSrv];
    }
    setDnsServers(newServers);
    save('sim-dns-servers', newServers);
    setShowServerForm(false);
    setEditingServer(null);
  };

  const handleDeleteServer = (id: string) => {
    const newServers = dnsServers.filter(s => s.id !== id);
    setDnsServers(newServers);
    save('sim-dns-servers', newServers);
  };

  const handleSaveHost = (host: Partial<DnsHost>) => {
    let newHosts: DnsHost[];
    if (editingHost) {
      newHosts = dnsHosts.map(h => h.id === editingHost.id ? { ...h, ...host } as DnsHost : h);
    } else {
      const newH: DnsHost = {
        id: Math.random().toString(36).substr(2, 9),
        domain: host.domain || '',
        ip: host.ip || ''
      };
      newHosts = [...dnsHosts, newH];
    }
    setDnsHosts(newHosts);
    save('sim-dns-hosts', newHosts);
    setShowHostForm(false);
    setEditingHost(null);
  };

  const handleDeleteHost = (id: string) => {
    const newHosts = dnsHosts.filter(h => h.id !== id);
    setDnsHosts(newHosts);
    save('sim-dns-hosts', newHosts);
  };

  const toggleFakeDns = () => {
    const val = !fakeDns;
    setFakeDns(val);
    save('sim-fakedns', val);
  };

  const changeStrategy = (s: string) => {
    setDomainStrategy(s);
    save('sim-domain-strategy', s);
  };

  const changeQueryStrategy = (s: string) => {
    setQueryStrategy(s);
    save('sim-dns-query-strategy', s);
  };

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-[#0a0a1a]' : 'bg-[#f8fafc]'}`}>
      {/* Header */}
      <div className="flex items-center gap-4 p-4 pt-10 sm:pt-12 pb-3 shrink-0 border-b border-[#2a2a5a22]">
        <button onClick={onBack} className="w-10 h-10 rounded-xl glass-card flex items-center justify-center text-gray-400 hover:text-[var(--accent)] transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h2 className="font-orbitron text-xl font-bold text-white tracking-wide">DNS Настройки</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Конфигурация разрешения имен</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 lg:max-w-2xl lg:mx-auto lg:w-full">

        {/* Fake DNS & Strategy */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Zap size={16} className="text-[#ffe600]" />
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Глобальные</h3>
          </div>

          <div className="glass-card rounded-2xl border border-[#2a2a5a22] overflow-hidden divide-y divide-[#2a2a5a11]">
            <div className="flex items-center justify-between p-4">
              <div className="flex-1">
                <p className="text-sm font-semibold text-white">Fake DNS</p>
                <p className="text-[10px] text-gray-500 mt-1">Использовать фиктивные IP для ускорения (рекомендуется для TUN)</p>
              </div>
              <button onClick={toggleFakeDns}
                className={`relative w-[44px] h-[24px] rounded-full transition-all duration-300 ${fakeDns ? 'bg-[var(--accent)]' : 'bg-[#1a1a3a]'}`}>
                <motion.div className="absolute top-[2px] w-5 h-5 rounded-full bg-white shadow-md"
                  animate={{ left: fakeDns ? 21 : 3 }} transition={{ type: 'spring', damping: 20 }} />
              </button>
            </div>

            <div className="p-4">
              <p className="text-sm font-semibold text-white mb-2">Стратегия разрешения</p>
              <div className="grid grid-cols-3 gap-2">
                {['AsIs', 'IPIfNonMatch', 'IPOnDemand'].map(s => (
                  <button key={s} onClick={() => changeStrategy(s)}
                    className={`px-2 py-2 rounded-xl text-[10px] font-bold border transition-all ${domainStrategy === s ? 'bg-[var(--accent-a15)] border-[var(--accent-a44)] text-[var(--accent)]' : 'bg-[#12122a] border-[#2a2a5a33] text-gray-500 hover:text-gray-300'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4">
              <p className="text-sm font-semibold text-white mb-2">DNS Query Strategy</p>
              <div className="grid grid-cols-2 gap-2">
                {['UseIPv4', 'UseIPv6', 'UseIP', 'DualStack'].map(s => (
                  <button key={s} onClick={() => changeQueryStrategy(s)}
                    className={`px-2 py-2 rounded-xl text-[10px] font-bold border transition-all ${queryStrategy === s ? 'bg-[#b000ff15] border-[#b000ff44] text-[#b000ff]' : 'bg-[#12122a] border-[#2a2a5a33] text-gray-500 hover:text-gray-300'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* DNS Servers */}
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Server size={16} className="text-[var(--accent)]" />
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Серверы DNS</h3>
            </div>
            <button onClick={() => { setEditingServer(null); setShowServerForm(true); }}
              className="w-8 h-8 rounded-lg bg-[var(--accent-a15)] border border-[var(--accent-a33)] flex items-center justify-center text-[var(--accent)]">
              <Plus size={16} />
            </button>
          </div>

          <div className="space-y-2">
            {dnsServers.map(srv => (
              <div key={srv.id} className="glass-card p-4 rounded-2xl border border-[#2a2a5a22] flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${srv.enabled ? 'bg-[var(--accent-a15)] text-[var(--accent)]' : 'bg-gray-800 text-gray-600'}`}>
                  < Globe size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{srv.name}</p>
                  <p className="text-[10px] text-gray-500 font-mono truncate">{srv.address}</p>
                  {srv.domains && srv.domains.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {srv.domains.map(d => (
                        <span key={d} className="text-[8px] px-1.5 py-0.5 rounded bg-[#ffffff05] text-gray-400 border border-[#ffffff10]">{d}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setEditingServer(srv); setShowServerForm(true); }} className="p-2 text-gray-500 hover:text-[var(--accent)] transition-colors"><Settings2 size={16}/></button>
                  <button onClick={() => handleDeleteServer(srv.id)} className="p-2 text-gray-500 hover:text-red-500 transition-colors"><Trash2 size={16}/></button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* DNS Hosts (Local Mappings) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Database size={16} className="text-[#b000ff]" />
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">DNS Hosts</h3>
            </div>
            <button onClick={() => { setEditingHost(null); setShowHostForm(true); }}
              className="w-8 h-8 rounded-lg bg-[#b000ff15] border border-[#b000ff33] flex items-center justify-center text-[#b000ff]">
              <Plus size={16} />
            </button>
          </div>

          <div className="glass-card rounded-2xl border border-[#2a2a5a22] overflow-hidden">
            {dnsHosts.length === 0 ? (
              <div className="p-6 text-center text-gray-600 italic text-xs">Нет локальных DNS записей</div>
            ) : (
              <div className="divide-y divide-[#2a2a5a11]">
                {dnsHosts.map(host => (
                  <div key={host.id} className="flex items-center justify-between p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-white font-mono truncate">{host.domain}</p>
                      <p className="text-[10px] text-gray-500 font-mono">{host.ip}</p>
                    </div>
                    <div className="flex gap-1 ml-4">
                      <button onClick={() => { setEditingHost(host); setShowHostForm(true); }} className="p-2 text-gray-500 hover:text-[#b000ff]"><Settings2 size={14}/></button>
                      <button onClick={() => handleDeleteHost(host.id)} className="p-2 text-gray-500 hover:text-red-500"><Trash2 size={14}/></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Server Form Overlay */}
      <AnimatePresence>
        {showServerForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
            <motion.div key={editingServer?.address ?? 'new-server'} initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="w-full max-w-sm glass-card rounded-3xl border border-[#2a2a5a55] p-6 space-y-4">
              <h4 className="font-orbitron text-sm font-bold text-white">{editingServer ? 'Изменить сервер' : 'Новый DNS сервер'}</h4>
              <div className="space-y-3">
                <input id="srv-name" placeholder="Название (Cloudflare, Google...)" defaultValue={editingServer?.name} className="w-full bg-[#12122a] border border-[#2a2a5a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[var(--accent-a44)]" />
                <input id="srv-addr" placeholder="Адрес (8.8.8.8, https://...)" defaultValue={editingServer?.address} className="w-full bg-[#12122a] border border-[#2a2a5a] rounded-xl px-4 py-3 text-sm text-white font-mono focus:outline-none focus:border-[var(--accent-a44)]" />
                <textarea id="srv-domains" placeholder="Домены через запятую (необязательно)" defaultValue={editingServer?.domains?.join(', ')} className="w-full bg-[#12122a] border border-[#2a2a5a] rounded-xl px-4 py-3 text-sm text-white h-24 resize-none focus:outline-none focus:border-[var(--accent-a44)]" />
              </div>
              <div className="flex gap-3">
                <button onClick={() => setShowServerForm(false)} className="flex-1 py-3 rounded-xl bg-gray-800 text-white text-xs font-bold">ОТМЕНА</button>
                <button onClick={() => {
                  const n = (document.getElementById('srv-name') as HTMLInputElement).value;
                  const a = (document.getElementById('srv-addr') as HTMLInputElement).value;
                  const d = (document.getElementById('srv-domains') as HTMLTextAreaElement).value.split(',').map(x => x.trim()).filter(Boolean);
                  if (!a) return;
                  handleSaveServer({ name: n, address: a, domains: d });
                }} className="flex-1 py-3 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#00c4d6] text-black text-xs font-bold">СОХРАНИТЬ</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Host Form Overlay */}
      <AnimatePresence>
        {showHostForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
            <motion.div key={editingHost?.domain ?? 'new-host'} initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="w-full max-w-sm glass-card rounded-3xl border border-[#2a2a5a55] p-6 space-y-4">
              <h4 className="font-orbitron text-sm font-bold text-white">{editingHost ? 'Изменить Host' : 'Новый Host'}</h4>
              <div className="space-y-3">
                <input id="host-domain" placeholder="example.com" defaultValue={editingHost?.domain} className="w-full bg-[#12122a] border border-[#2a2a5a] rounded-xl px-4 py-3 text-sm text-white font-mono focus:outline-none focus:border-[#b000ff44]" />
                <input id="host-ip" placeholder="1.2.3.4" defaultValue={editingHost?.ip} className="w-full bg-[#12122a] border border-[#2a2a5a] rounded-xl px-4 py-3 text-sm text-white font-mono focus:outline-none focus:border-[#b000ff44]" />
              </div>
              <div className="flex gap-3">
                <button onClick={() => setShowHostForm(false)} className="flex-1 py-3 rounded-xl bg-gray-800 text-white text-xs font-bold">ОТМЕНА</button>
                <button onClick={() => {
                  const d = (document.getElementById('host-domain') as HTMLInputElement).value;
                  const i = (document.getElementById('host-ip') as HTMLInputElement).value;
                  if (!d || !i) return;
                  handleSaveHost({ domain: d, ip: i });
                }} className="flex-1 py-3 rounded-xl bg-gradient-to-r from-[#b000ff] to-[#d946ef] text-white text-xs font-bold">СОХРАНИТЬ</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
