import React, { useState } from 'react';
import { X, RefreshCw, ShieldCheck, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface CaptchaModalProps {
    imageSrc: string;
    onSolve: (answer: string) => void;
    onCancel: () => void;
    onRefresh: () => void;
    message?: string;
    resetSeq?: number;
}

export const CaptchaModal: React.FC<CaptchaModalProps & { isLoading?: boolean }> = ({ imageSrc, onSolve, onCancel, onRefresh, message, resetSeq = 0, isLoading = false }) => {
    const [answer, setAnswer] = useState('');
    const inputRef = React.useRef<HTMLInputElement>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSolve(answer);
    };

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isLoading) {
                onCancel();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onCancel, isLoading]);

    React.useEffect(() => {
        setAnswer('');
        inputRef.current?.focus();
    }, [resetSeq]);

    return (
        <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial="hidden"
            animate="visible"
            exit="hidden"
            variants={{
                hidden: { opacity: 0 },
                visible: { opacity: 1, transition: { duration: 0.2 } }
            }}
        >
            <div
                className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
                onClick={!isLoading ? onCancel : undefined}
            />
            <motion.div
                className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl max-w-sm w-full overflow-hidden relative z-10 border border-gray-100 dark:border-slate-800"
                variants={{
                    hidden: { opacity: 0, scale: 0.9, y: 20 },
                    visible: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', damping: 25, stiffness: 300 } }
                }}
            >
                <div className="p-6">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
                            <motion.div
                                initial={{ rotate: -10, scale: 0.8 }}
                                animate={{ rotate: 0, scale: 1 }}
                                className="p-1.5 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400"
                            >
                                <ShieldCheck size={20} />
                            </motion.div>
                            Security Check
                        </h3>
                        <div className="flex gap-2">
                            <button onClick={onRefresh} disabled={isLoading} className="text-gray-400 dark:text-gray-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 p-2 rounded-full transition-all disabled:opacity-50" title="Refresh Captcha">
                                <RefreshCw size={20} className={isLoading ? "animate-spin" : ""} />
                            </button>
                            <button onClick={onCancel} disabled={isLoading} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 p-2 rounded-full transition-all disabled:opacity-50">
                                <X size={20} />
                            </button>
                        </div>
                    </div>

                    <AnimatePresence>
                        {message && (
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                className="mb-4 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 px-4 py-4 rounded-xl text-sm font-medium border border-amber-100 dark:border-amber-900/30 flex items-center gap-3 overflow-hidden min-h-[3.5rem]"
                            >
                                <div className="p-1 bg-amber-200/50 dark:bg-amber-900/40 rounded-lg shrink-0">
                                    <Info size={14} className="text-amber-700 dark:text-amber-300" />
                                </div>
                                <div className="flex-1 leading-normal break-words">
                                    {message}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
                        Please enter the characters shown below to securely access your grades.
                    </p>

                    <div className="flex justify-center mb-6 bg-gray-50 dark:bg-slate-800/50 p-4 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-inner min-h-[5rem] items-center text-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-grid-slate-200 dark:bg-grid-slate-700 [mask-image:linear-gradient(0deg,white,rgba(255,255,255,0.6))] opacity-20"></div>
                        {imageSrc ? (
                            <motion.img
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                src={imageSrc}
                                alt="Captcha"
                                className="h-16 object-contain rounded mx-auto relative z-10"
                            />
                        ) : (
                            <div className="flex items-center gap-2 text-indigo-500 font-medium animate-pulse relative z-10">
                                <RefreshCw className="animate-spin w-5 h-5" />
                                <span>Loading...</span>
                            </div>
                        )}
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <input
                            ref={inputRef}
                            type="text"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            className="w-full text-center text-3xl font-mono font-bold tracking-[0.5em] px-4 py-4 rounded-xl border-2 border-gray-100 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none uppercase transition-all placeholder:tracking-normal placeholder:text-gray-300 placeholder:text-lg placeholder:font-sans dark:bg-gray-800 dark:text-white dark:border-gray-700 dark:placeholder:text-gray-600"
                            placeholder="Enter Code"
                            autoFocus
                            required
                            disabled={isLoading}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                        />
                        <button
                            type="submit"
                            disabled={isLoading}
                            className="w-full py-4 px-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:from-indigo-400 disabled:to-purple-400 text-white font-bold uppercase tracking-wider rounded-xl shadow-lg shadow-indigo-500/30 transition-all active:scale-[0.98] transform flex items-center justify-center gap-2"
                        >
                            {isLoading && <RefreshCw className="animate-spin w-5 h-5" />}
                            {isLoading ? 'Verifying...' : 'Verify & View Grades'}
                        </button>
                    </form>
                </div>
                <div className="bg-gray-50 dark:bg-slate-800/50 px-6 py-4 border-t border-gray-100 dark:border-slate-800 text-center">
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold flex items-center justify-center gap-1">
                        <LockIcon size={10} /> Secure Connection
                    </p>
                </div>
            </motion.div>
        </motion.div>
    );
};

const LockIcon = ({ size }: { size: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
);
