/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettingsStore } from '../../store/useSettingsStore';
import { ArrowRight, Check, Zap, Command, Layers } from 'lucide-react';
import { clsx } from 'clsx';

const ShortcutKey = ({ label, keys }: { label: string; keys: string[] }) => (
    <div className="flex flex-col gap-1 p-3 rounded-lg bg-input/30 border border-border">
        <span className="text-xs text-text-secondary">{label}</span>
        <div className="flex gap-1">
            {keys.map((k) => (
                <kbd key={k} className="px-1.5 py-0.5 rounded bg-editor border border-border text-[10px] font-mono min-w-[20px] text-center shadow-sm">
                    {k}
                </kbd>
            ))}
        </div>
    </div>
);

const SLIDES = [
    {
        id: 'welcome',
        title: 'Welcome to Aurora',
        subtitle: 'The next-generation AI-native IDE designed for speed and flow.',
        icon: <Zap className="w-12 h-12 text-primary" />,
        features: [
            { text: 'AI-Native Workflow', icon: <Zap size={16} /> },
            { text: 'Lightning Fast', icon: <Command size={16} /> },
            { text: 'Zero Config', icon: <Layers size={16} /> }
        ]
    },
    {
        id: 'shortcuts',
        title: 'Master the Flow',
        subtitle: 'Everything is just a shortcut away. Keep your hands on the keyboard.',
        content: (
            <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
                <ShortcutKey label="Command Palette" keys={['Ctrl', 'Shift', 'P']} />
                <ShortcutKey label="Quick Open" keys={['Ctrl', 'P']} />
                <ShortcutKey label="AI Chat" keys={['Ctrl', 'L']} />
                <ShortcutKey label="Terminal" keys={['Ctrl', '`']} />
            </div>
        )
    },
    {
        id: 'ready',
        title: "You're All Set",
        subtitle: 'Start building the future. Your timeline is now initialized.',
        icon: <Check className="w-16 h-16 text-success" />,
        content: (
            <div className="text-center text-text-secondary text-sm">
                <p>No account required.</p>
                <p>Your workspace is ready.</p>
            </div>
        )
    }
];

export const OnboardingModal: React.FC = () => {
    const { hasSeenOnboarding, setHasSeenOnboarding } = useSettingsStore();
    const [isOpen, setIsOpen] = useState(false);
    const [currentSlide, setCurrentSlide] = useState(0);

    useEffect(() => {
        // Check if seen after store is initialized and small delay
        const timer = setTimeout(() => {
            if (!hasSeenOnboarding) {
                setIsOpen(true);
            }
        }, 1000);
        return () => clearTimeout(timer);
    }, [hasSeenOnboarding]);

    const handleNext = () => {
        if (currentSlide < SLIDES.length - 1) {
            setCurrentSlide(c => c + 1);
        } else {
            handleComplete();
        }
    };

    const handleComplete = () => {
        setIsOpen(false);
        setTimeout(() => {
            setHasSeenOnboarding(true);
        }, 500); // Wait for exit animation
    };

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                    />

                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 20 }}
                        className="relative w-full max-w-2xl bg-[#090909] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row h-[500px]"
                    >
                        {/* Left Side: Visual/Animation */}
                        <div className="w-full md:w-5/12 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent relative overflow-hidden flex items-center justify-center p-8">
                            <div className="absolute inset-0 bg-[url('/noise.png')] opacity-[0.03] mix-blend-overlay"></div>

                            {/* Abstract animated shapes */}
                            <motion.div
                                animate={{ rotate: 360 }}
                                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                                className="absolute -top-20 -left-20 w-64 h-64 bg-primary/20 rounded-full blur-3xl opacity-30"
                            />
                            <motion.div
                                animate={{ rotate: -360 }}
                                transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
                                className="absolute -bottom-20 -right-20 w-64 h-64 bg-secondary/20 rounded-full blur-3xl opacity-30"
                            />

                            <AnimatePresence mode="wait">
                                <motion.div
                                    key={currentSlide}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -20 }}
                                    transition={{ duration: 0.4 }}
                                    className="relative z-10 flex flex-col items-center gap-6"
                                >
                                    {SLIDES[currentSlide].icon && (
                                        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 shadow-lg backdrop-blur-md">
                                            {SLIDES[currentSlide].icon}
                                        </div>
                                    )}

                                    {SLIDES[currentSlide].features && (
                                        <div className="space-y-3 w-full">
                                            {SLIDES[currentSlide].features.map((f, i) => (
                                                <motion.div
                                                    key={i}
                                                    initial={{ opacity: 0, x: -20 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    transition={{ delay: i * 0.1 + 0.2 }}
                                                    className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                                                >
                                                    <div className="text-primary">{f.icon}</div>
                                                    <span className="text-sm font-medium text-text-primary">{f.text}</span>
                                                </motion.div>
                                            ))}
                                        </div>
                                    )}
                                </motion.div>
                            </AnimatePresence>
                        </div>

                        {/* Right Side: Content */}
                        <div className="flex-1 flex flex-col p-8 md:p-10 relative bg-[#090909]">
                            <div className="flex items-center justify-between mb-8">
                                <div className="flex gap-1.5 sora-font font-bold text-lg tracking-tight">
                                    <span className="text-primary">Aurora</span>
                                    <span className="text-text-secondary">IDE</span>
                                </div>
                                {/* Progress dots */}
                                <div className="flex gap-2">
                                    {SLIDES.map((_, i) => (
                                        <div
                                            key={i}
                                            className={clsx(
                                                "w-2 h-2 rounded-full transition-all duration-300",
                                                i === currentSlide ? "bg-primary w-6" : "bg-white/10"
                                            )}
                                        />
                                    ))}
                                </div>
                            </div>

                            <div className="flex-1 flex flex-col justify-center">
                                <AnimatePresence mode="wait">
                                    <motion.div
                                        key={currentSlide}
                                        initial={{ opacity: 0, x: 20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: -20 }}
                                        transition={{ duration: 0.3 }}
                                        className="space-y-6"
                                    >
                                        <div className="space-y-2">
                                            <h2 className="text-3xl font-bold text-white tracking-tight">{SLIDES[currentSlide].title}</h2>
                                            <p className="text-text-secondary leading-relaxed">{SLIDES[currentSlide].subtitle}</p>
                                        </div>

                                        {SLIDES[currentSlide].content}
                                    </motion.div>
                                </AnimatePresence>
                            </div>

                            <div className="mt-8 flex items-center justify-between pt-6 border-t border-white/5">
                                <button
                                    onClick={handleComplete}
                                    className="text-sm text-text-secondary hover:text-white transition-colors"
                                >
                                    Skip
                                </button>

                                <button
                                    onClick={handleNext}
                                    className="group flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-white font-medium hover:bg-primary/90 transition-all shadow-lg hover:shadow-primary/25"
                                >
                                    {currentSlide === SLIDES.length - 1 ? 'Get Started' : 'Next'}
                                    <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
