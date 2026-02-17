import React, { useState } from 'react';
import { Lock, User, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { motion } from 'framer-motion';

interface LoginProps {
    onLogin: (creds: { username: string; pass: string; remember: boolean }) => void;
    loading?: boolean;
    darkMode: boolean;
    toggleTheme: () => void;
    autoSolveEnabled: boolean;
    onAutoSolveChange: (enabled: boolean) => void;
}

export const Login: React.FC<LoginProps> = ({
    onLogin,
    loading = false,
    darkMode,
    toggleTheme,
    autoSolveEnabled,
    onAutoSolveChange
}) => {
    const [username, setUsername] = useState(() => localStorage.getItem('up_user') || '');
    const [password, setPassword] = useState(() => {
        const saved = localStorage.getItem('up_pass');
        return saved ? atob(saved) : '';
    });
    const [remember, setRemember] = useState(true);
    const [showPassword, setShowPassword] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onLogin({ username, pass: password, remember });
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 dark:bg-slate-950 p-4 transition-colors duration-500 overflow-hidden relative">
            {/* Background elements for depth */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
                <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-indigo-500/10 dark:bg-indigo-500/20 rounded-full blur-[120px]"></div>
                <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-purple-500/10 dark:bg-purple-500/20 rounded-full blur-[120px]"></div>
            </div>

            <button
                onClick={toggleTheme}
                className="absolute top-6 right-6 p-3 rounded-full bg-slate-200/50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700 transition-all z-20 backdrop-blur-sm shadow-lg"
            >
                {darkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
            </button>
            <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md p-8 rounded-3xl shadow-2xl w-full max-w-md border border-white/20 dark:border-white/5 z-10">
                <div className="flex items-center justify-center mb-8">
                    <div className="bg-indigo-600/10 dark:bg-indigo-600/20 p-4 rounded-full shadow-inner">
                        <div className="bg-indigo-600 p-3 rounded-full shadow-lg shadow-indigo-400/50">
                            <User className="text-white w-8 h-8" />
                        </div>
                    </div>
                </div>
                <h2 className="text-3xl font-extrabold text-center text-gray-800 dark:text-gray-100 mb-2 tracking-tight">Student Portal</h2>
                <p className="text-center text-gray-500 dark:text-gray-400 mb-8 text-sm font-medium">Access your University of Patras grades</p>

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="group space-y-2">
                        <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 ml-1">Username</label>
                        <div className="relative transform transition-all group-hover:scale-[1.01]">
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full px-5 py-4 rounded-xl border-none bg-gray-100/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-800 focus:ring-4 focus:ring-indigo-500/20 shadow-inner text-gray-700 dark:text-gray-200 font-medium outline-none transition-all pl-12"
                                placeholder="upXXXXXXX"
                                required
                                disabled={loading}
                            />
                            <User className="absolute left-4 top-4 w-5 h-5 text-gray-400 dark:text-gray-500 group-focus-within:text-indigo-500 transition-colors" />
                        </div>
                    </div>

                    <div className="group space-y-2">
                        <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 ml-1">Password</label>
                        <div className="relative transform transition-all group-hover:scale-[1.01]">
                            <input
                                type={showPassword ? "text" : "password"}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-5 py-4 rounded-xl border-none bg-gray-100/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-800 focus:ring-4 focus:ring-indigo-500/20 shadow-inner text-gray-700 dark:text-gray-200 font-medium outline-none transition-all pl-12 pr-12"
                                placeholder="Password"
                                required
                                disabled={loading}
                            />
                            <Lock className="absolute left-4 top-4 w-5 h-5 text-gray-400 dark:text-gray-500 group-focus-within:text-indigo-500 transition-colors" />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-4 top-4 text-gray-400 dark:text-gray-500 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors focus:outline-none"
                            >
                                <motion.span
                                    key={showPassword ? "visible" : "hidden"}
                                    initial={{ scale: 0.8, opacity: 0, rotate: -20 }}
                                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                                    exit={{ scale: 0.8, opacity: 0, rotate: 20 }}
                                    transition={{ duration: 0.2 }}
                                    className="flex items-center justify-center"
                                >
                                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                </motion.span>
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center ml-1">
                        <input
                            id="remember-me"
                            type="checkbox"
                            checked={remember}
                            onChange={(e) => setRemember(e.target.checked)}
                            className="w-5 h-5 rounded text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-slate-800 focus:ring-offset-0 cursor-pointer"
                        />
                        <label htmlFor="remember-me" className="ml-3 block text-sm font-medium text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                            Remember Login
                        </label>
                    </div>

                    <div className="flex items-center ml-1">
                        <input
                            id="auto-solve"
                            type="checkbox"
                            checked={autoSolveEnabled}
                            onChange={(e) => onAutoSolveChange(e.target.checked)}
                            className="w-5 h-5 rounded text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-slate-800 focus:ring-offset-0 cursor-pointer"
                            disabled={loading}
                        />
                        <label htmlFor="auto-solve" className="ml-3 block text-sm font-medium text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                            Auto Solve Captcha
                        </label>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-4 px-4 rounded-xl shadow-xl hover:shadow-2xl hover:shadow-indigo-500/30 text-sm font-bold uppercase tracking-widest text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transform active:scale-[0.98] transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none"
                    >
                        {loading ? (
                            <div className="flex items-center justify-center gap-2">
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <span>Logging In...</span>
                            </div>
                        ) : 'Log In securely'}
                    </button>
                </form>

                <p className="mt-8 text-center text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
                    Credentials are stored locally on your device for login convenience.<br />
                    If push notifications are enabled, server-side password storage requires explicit consent.
                </p>
            </div>
        </div>
    );
};
