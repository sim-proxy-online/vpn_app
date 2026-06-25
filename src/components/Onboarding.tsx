import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Globe, FolderPlus, Zap, ChevronRight, Check } from 'lucide-react';
import { useI18n } from '../i18n';

interface Slide {
  icon: React.ReactNode;
  tkey: string; // префикс ключей i18n: <tkey>.title / <tkey>.text
  accent: string;
}

const SLIDES: Slide[] = [
  { icon: <Shield size={40} />,     tkey: 'onboard.1', accent: 'var(--accent)' },
  { icon: <FolderPlus size={40} />, tkey: 'onboard.2', accent: '#00ff88' },
  { icon: <Zap size={40} />,        tkey: 'onboard.3', accent: '#ffe600' },
  { icon: <Globe size={40} />,      tkey: 'onboard.4', accent: '#b000ff' },
];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [i, setI] = useState(0);
  const last = i === SLIDES.length - 1;
  const s = SLIDES[i];

  const next = () => { if (last) onDone(); else setI(i + 1); };

  return (
    <div className="fixed inset-0 z-[200] bg-[#0a0a1a] flex flex-col">
      {/* Декоративное свечение */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80%] h-[40%] rounded-full blur-[120px] opacity-20 pointer-events-none"
        style={{ background: s.accent }} />

      <div className="flex justify-end p-5 pt-12 relative z-10">
        {!last && (
          <button onClick={onDone} className="text-gray-500 text-xs font-bold uppercase tracking-widest hover:text-white transition-colors">
            {t('common.skip')}
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center relative z-10">
        <AnimatePresence mode="wait">
          <motion.div key={i}
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }} className="flex flex-col items-center">
            <div className="w-24 h-24 rounded-[28px] flex items-center justify-center mb-8 border"
              style={{ background: `${s.accent}18`, borderColor: `${s.accent}44`, color: s.accent, boxShadow: `0 0 40px ${s.accent}22` }}>
              {s.icon}
            </div>
            <h2 className="font-orbitron text-2xl font-bold text-white mb-4 leading-tight">{t(`${s.tkey}.title`)}</h2>
            <p className="text-gray-400 text-sm leading-relaxed max-w-xs">{t(`${s.tkey}.text`)}</p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Точки-индикаторы */}
      <div className="flex justify-center gap-2 mb-8 relative z-10">
        {SLIDES.map((_, idx) => (
          <div key={idx}
            className="h-1.5 rounded-full transition-all duration-300"
            style={{ width: idx === i ? 24 : 8, background: idx === i ? s.accent : '#ffffff22' }} />
        ))}
      </div>

      <div className="px-8 pb-[calc(32px+env(safe-area-inset-bottom,0px))] relative z-10">
        <button onClick={next}
          className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-black font-orbitron text-sm font-black tracking-widest uppercase active:scale-[0.98] transition-all"
          style={{ background: s.accent, boxShadow: `0 0 24px ${s.accent}55` }}>
          {last ? (<><Check size={18} /> {t('common.start')}</>) : (<>{t('common.next')} <ChevronRight size={18} /></>)}
        </button>
      </div>
    </div>
  );
}
