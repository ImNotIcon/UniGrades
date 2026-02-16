import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title, PointElement, LineElement, Filler } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Pie, Bar, Line } from 'react-chartjs-2';
import { LogOut, RefreshCw, Moon, Sun, ArrowLeft, Bell, BellOff } from 'lucide-react';
import type { Grade, StudentInfo } from '../types';

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title, PointElement, LineElement, Filler);

interface DashboardProps {
    allGrades: Grade[];
    fullHistory: Grade[];
    studentInfo: StudentInfo | null;
    onLogout: () => void;
    onRefresh: () => void;
    isLoading: boolean;
    isBackgroundLoading?: boolean;
    darkMode: boolean;
    toggleTheme: () => void;
    selectedCourseCode: string | null;
    onSelectCourse: (code: string | null) => void;
    animateOut?: boolean;
}

const getGradeStatus = (gradeStr: string) => {
    if (!gradeStr || !gradeStr.trim()) return 'neutral';
    const val = parseFloat(gradeStr.replace(',', '.'));
    if (isNaN(val)) return 'failed';
    if (val >= 5) return 'passed';
    return 'failed';
};

const getStatusColor = (status: 'passed' | 'failed' | 'neutral', darkMode: boolean, isText = false) => {
    if (status === 'passed') return isText ? 'text-green-500' : 'bg-green-500';
    if (status === 'failed') return isText ? 'text-red-500' : 'bg-red-500';
    return isText ? (darkMode ? 'text-gray-400' : 'text-gray-500') : (darkMode ? 'bg-gray-700' : 'bg-gray-400');
};

const stripAccents = (str: string | undefined) => {
    if (!str) return '';
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
};

const ectsInt = (val: string | undefined) => {
    if (!val) return '0';
    const n = parseFloat(val.replace(',', '.'));
    return isNaN(n) ? val : Math.round(n).toString();
};

const CourseDetailView: React.FC<{
    data: { latest: Grade; history: Grade[] };
    darkMode: boolean;
    onSelectCourse: (code: string | null) => void;
    detailRef: React.RefObject<HTMLDivElement | null>;
    barOptions: any;
    stripAccents: (s: string) => string;
    animateOut: boolean;
}> = ({ data, darkMode, onSelectCourse, detailRef, barOptions, stripAccents, animateOut }) => {
    const { latest, history } = data;



    const lineData = {
        labels: history.map(h => h.year.split('-')[1] || h.year),
        datasets: [{
            data: history.map(h => {
                const v = parseFloat(h.grade.replace(',', '.'));
                return isNaN(v) ? null : v;
            }),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            pointBackgroundColor: history.map(h => {
                const v = parseFloat(h.grade.replace(',', '.'));
                if (isNaN(v)) return 'transparent';
                return v >= 5 ? '#10b981' : '#ef4444';
            }),
            pointBorderColor: history.map(h => {
                const v = parseFloat(h.grade.replace(',', '.'));
                return isNaN(v) ? 'transparent' : '#6366f1';
            }),
            pointRadius: 6,
            tension: 0.3,
            fill: true,
            spanGaps: true
        }]
    };

    return (
        <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={animateOut ? { x: '100%', transition: { type: 'tween', ease: 'easeOut', duration: 0.25 } } : undefined}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            className="fixed inset-0 z-50 overflow-hidden"
        >
            <div ref={detailRef} className={`min-h-screen h-screen overflow-y-auto transition-colors duration-300 ${darkMode ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
                <header className="sticky top-0 z-50 bg-white/80 dark:bg-gray-800/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-700 h-24 flex items-center px-4">
                    <button onClick={() => onSelectCourse(null)} className="p-3 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors">
                        <ArrowLeft className="w-6 h-6" />
                    </button>
                    <div className="flex-1 px-4 overflow-hidden">
                        <h2 className="text-base md:text-xl font-black text-center px-4 uppercase tracking-tight leading-tight line-clamp-2">
                            {latest.title}
                        </h2>
                    </div>
                    <div className="w-10"></div>
                </header>

                <main className="max-w-4xl mx-auto px-4 pt-8 pb-12 space-y-6">
                    <div className="space-y-6">
                        <div className={`p-6 rounded-2xl border transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <span className="text-xs uppercase font-black opacity-50 block mb-1">Status</span>
                                    <div className="flex items-center gap-2">
                                        <div className={`w-3 h-3 rounded-full ${getStatusColor(getGradeStatus(latest.grade), darkMode)}`} />
                                        <span className="font-bold">
                                            {getGradeStatus(latest.grade) === 'passed' ? 'Passed' :
                                                getGradeStatus(latest.grade) === 'failed' ? 'Failed' : 'No grade'}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex justify-center py-4">
                                <GradeGauge grade={latest.grade || ''} statusColor={getStatusColor(getGradeStatus(latest.grade), darkMode, true)} darkMode={darkMode} />
                            </div>

                            <div className={`mt-6 p-4 rounded-xl border flex items-center justify-between ${darkMode ? 'bg-gray-900/50 border-gray-700' : 'bg-gray-50 border-gray-100'}`}>
                                <div className="text-center flex-1">
                                    <span className="text-[10px] block uppercase font-black opacity-50 mb-1">Total ECTS</span>
                                    <span className="text-xl font-bold">{ectsInt(latest.ects) || '0'}</span>
                                </div>
                                <div className={`w-px h-8 ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`} />
                                <div className="text-center flex-1">
                                    <span className="text-[10px] block uppercase font-black opacity-50 mb-1">Weighting</span>
                                    <span className="text-xl font-bold">{latest.gravity || '—'}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className={`p-6 rounded-2xl border transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                        <h3 className="text-sm font-black uppercase tracking-widest mb-4 opacity-50">Score History</h3>
                        <div className="h-[250px]">
                            <Line
                                data={lineData}
                                options={{
                                    ...barOptions,
                                    scales: {
                                        ...barOptions.scales,
                                        x: {
                                            ...barOptions.scales?.x || {},
                                            offset: history.length === 1
                                        }
                                    },
                                    plugins: { ...barOptions.plugins, legend: { display: false } }
                                }}
                            />
                        </div>
                    </div>

                    <div className={`p-6 rounded-2xl border transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                        <h3 className="text-sm font-black uppercase tracking-widest mb-6 opacity-50">All Attempts</h3>
                        <div className="space-y-3">
                            {history.slice().reverse().map((h: Grade, i: number) => {
                                const status = getGradeStatus(h.grade);
                                const c = getStatusColor(status, darkMode, true);
                                return (
                                    <div key={`${h.code}-${i}`} className={`flex justify-between items-center p-4 rounded-xl ${darkMode ? 'bg-gray-900/50' : 'bg-gray-50'}`}>
                                        <div className="flex-1 flex flex-col">
                                            <span className="text-sm font-bold">{h.year}</span>
                                            <span className="text-xs text-gray-500">
                                                {(h.acadSession || '').replace(/Εξάμηνο/gi, '').trim()} {h.year} {h.apprStatus ? `| ${h.apprStatus}` : ''}
                                            </span>
                                        </div>
                                        <div className="shrink-0 w-20 flex flex-col items-center justify-center">
                                            <span className={`text-lg font-black ${c}`}>{h.grade || '—'}</span>
                                            <p className="text-[10px] uppercase font-bold text-gray-400 text-center">
                                                {stripAccents(h.bkgStatus || h.status)}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </main>
            </div>
        </motion.div>
    );
};

const COLORS = ['#10B981', '#EF4444', '#6B7280']; // Green, Red, Gray

export const Dashboard: React.FC<DashboardProps> = ({
    allGrades,
    fullHistory,
    studentInfo,
    onLogout,
    onRefresh,
    isLoading,
    isBackgroundLoading = false,
    darkMode,
    toggleTheme,
    selectedCourseCode,
    onSelectCourse,
    animateOut = false,
}) => {
    const detailRef = React.useRef<HTMLDivElement>(null);
    const scrollingRef = React.useRef(false);
    const scrollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // --- Push Notification State ---
    const [notifEnabled, setNotifEnabled] = useState(() => {
        return localStorage.getItem('push_enabled') === 'true';
    });
    const [notifLoading, setNotifLoading] = useState(false);

    const API_URL = `http://${window.location.hostname}:3001/api`;

    const handleToggleNotifications = useCallback(async () => {
        if (notifLoading) return;
        setNotifLoading(true);

        try {
            if (notifEnabled) {
                // Unsubscribe
                const registration = await navigator.serviceWorker?.ready;
                const subscription = await registration?.pushManager?.getSubscription();
                if (subscription) await subscription.unsubscribe();

                const username = localStorage.getItem('up_user') || '';
                await fetch(`${API_URL}/push/unsubscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username })
                });

                setNotifEnabled(false);
                localStorage.setItem('push_enabled', 'false');
            } else {
                // Request permission
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                    setNotifLoading(false);
                    return;
                }

                // Get VAPID key from server
                const vapidRes = await fetch(`${API_URL}/push/vapid-key`);
                const { publicKey } = await vapidRes.json();
                if (!publicKey) throw new Error('No VAPID key configured');

                // Subscribe
                const registration = await navigator.serviceWorker?.ready;
                const subscription = await registration?.pushManager?.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: publicKey
                });

                if (!subscription) throw new Error('Failed to create subscription');

                // Send to server with user info
                const username = localStorage.getItem('up_user') || '';
                const storedCookies = localStorage.getItem('up_session_cookies');
                await fetch(`${API_URL}/push/subscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        subscription: subscription.toJSON(),
                        username,
                        cookies: storedCookies ? JSON.parse(storedCookies) : null
                    })
                });

                setNotifEnabled(true);
                localStorage.setItem('push_enabled', 'true');
            }
        } catch (err) {
            console.error('Push notification toggle failed:', err);
        } finally {
            setNotifLoading(false);
        }
    }, [notifEnabled, notifLoading, API_URL]);

    useEffect(() => {
        const onScroll = () => {
            scrollingRef.current = true;
            if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
            scrollTimerRef.current = setTimeout(() => {
                scrollingRef.current = false;
            }, 150);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        if (selectedCourseCode) {
            document.body.style.overflow = 'hidden';
            if (detailRef.current) detailRef.current.scrollTop = 0;
        } else {
            document.body.style.overflow = 'unset';
        }
        return () => { document.body.style.overflow = 'unset'; };
    }, [selectedCourseCode]);

    // Pull-to-refresh
    const PULL_THRESHOLD = 80;
    const [pullProgress, setPullProgress] = React.useState(0);
    const [isDischarging, setIsDischarging] = React.useState(false);
    const touchStartY = React.useRef<number | null>(null);
    const pullRef = React.useRef(0);
    const selectedRef = React.useRef(selectedCourseCode);
    selectedRef.current = selectedCourseCode;
    const refreshRef = React.useRef(onRefresh);
    refreshRef.current = onRefresh;
    const loadingRef = React.useRef(isLoading || isBackgroundLoading);
    loadingRef.current = isLoading || isBackgroundLoading;

    useEffect(() => {
        const onTouchStart = (e: TouchEvent) => {
            if (loadingRef.current || selectedRef.current) return;
            const el = document.scrollingElement || document.documentElement;
            if (el.scrollTop <= 0) {
                touchStartY.current = e.touches[0].clientY;
            }
        };

        const onTouchMove = (e: TouchEvent) => {
            if (touchStartY.current === null) return;
            const delta = e.touches[0].clientY - touchStartY.current;
            if (delta > 0) {
                const dampened = Math.min(delta * 0.5, PULL_THRESHOLD * 1.4);
                const progress = dampened / PULL_THRESHOLD;
                pullRef.current = progress;
                setIsDischarging(false);
                setPullProgress(progress);
            } else {
                pullRef.current = 0;
                setPullProgress(0);
            }
        };

        const onTouchEnd = () => {
            if (pullRef.current >= 1) {
                refreshRef.current();
            }
            touchStartY.current = null;
            pullRef.current = 0;
            setIsDischarging(true);
            setPullProgress(0);
        };

        window.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd);

        return () => {
            window.removeEventListener('touchstart', onTouchStart);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };
    }, []);

    const charged = pullProgress >= 1;

    const selectedCourseData = useMemo(() => {
        if (!selectedCourseCode) return null;
        const history = fullHistory
            .filter((g: Grade) => g.code === selectedCourseCode)
            .sort((a: Grade, b: Grade) => {
                const yearA = parseInt(a.year.split('-')[0]) || 0;
                const yearB = parseInt(b.year.split('-')[0]) || 0;
                if (yearA !== yearB) return yearA - yearB;
                const semA = parseInt(a.semester) || 0;
                const semB = parseInt(b.semester) || 0;
                return semA - semB;
            });

        const latest = allGrades.find((g: Grade) => g.code === selectedCourseCode) || history[history.length - 1];

        return { latest, history };
    }, [selectedCourseCode, fullHistory, allGrades]);

    // Group grades by semester
    const gradesBySemester = useMemo(() => {
        const groups = new Map<number, Grade[]>();
        allGrades.forEach((g: Grade) => {
            const sem = parseInt(g.semester) || 0;
            if (!groups.has(sem)) groups.set(sem, []);
            groups.get(sem)?.push(g);
        });

        const sortedKeys = Array.from(groups.keys()).sort((a, b) => b - a);

        return sortedKeys.map(key => ({
            semester: key,
            grades: groups.get(key) || []
        }));
    }, [allGrades]);

    const metricsData = useMemo(() => {
        let passed = 0;
        let failed = 0;
        let noGrade = 0;

        allGrades.forEach((g: Grade) => {
            const status = getGradeStatus(g.grade);
            if (status === 'passed') passed++;
            else if (status === 'failed') failed++;
            else noGrade++;
        });

        return {
            labels: ['Passed', 'Failed', 'No grade'],
            datasets: [
                {
                    data: [passed, failed, noGrade],
                    backgroundColor: COLORS,
                    borderColor: darkMode ? '#1f2937' : '#ffffff',
                    borderWidth: 2,
                },
            ],
        };
    }, [allGrades, darkMode]);

    const barChartData = useMemo(() => {
        const groups = new Map();
        allGrades.forEach((g: Grade) => {
            const val = parseFloat(g.grade);
            if (!isNaN(val) && val >= 5) {
                const key = g.semester.replace(/[^0-9]/g, '');
                const semInt = parseInt(key);
                const mapKey = isNaN(semInt) ? 0 : semInt;
                if (!groups.has(mapKey)) groups.set(mapKey, { count: 0, sum: 0 });
                const d = groups.get(mapKey);
                d.count++;
                d.sum += val;
            }
        });

        const dataPoints = Array.from(groups.entries()).map(([name, val]) => ({
            sem: name,
            avg: val.count > 0 ? parseFloat((val.sum / val.count).toFixed(2)) : 0,
        })).sort((a, b) => a.sem - b.sem);

        return {
            labels: dataPoints.map(d => d.sem === 0 ? 'Other' : `Sem ${d.sem}`),
            datasets: [
                {
                    label: 'Average Grade',
                    data: dataPoints.map(d => d.avg),
                    backgroundColor: '#6366f1',
                    borderRadius: 4,
                },
            ],
        };
    }, [allGrades]);

    const pieOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                position: 'bottom' as const,
                labels: {
                    color: darkMode ? '#fff' : '#374151',
                    font: { family: 'Inter, sans-serif', size: 14, weight: 'bold' as const },
                    usePointStyle: true,
                    boxWidth: 15,
                    padding: 20
                }
            },
            tooltip: {
                backgroundColor: darkMode ? '#374151' : '#fff',
                titleColor: darkMode ? '#fff' : '#111827',
                bodyColor: darkMode ? '#d1d5db' : '#4b5563',
                borderColor: darkMode ? '#4b5563' : '#e5e7eb',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
            },
            datalabels: {
                color: '#fff',
                font: { weight: 'bold' as const, size: 18 },
                formatter: (value: number, ctx: any) => {
                    if (value <= 0) return '';
                    const label = ctx.chart.data.labels?.[ctx.dataIndex] || '';
                    return `${label}\n${value}`;
                },
                textAlign: 'center' as const,
            }
        }
    };

    const barOptions = {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            y: {
                min: -0.5,
                max: 10.5,
                grid: { color: darkMode ? '#374151' : '#f3f4f6' },
                ticks: { color: darkMode ? '#9ca3af' : '#6b7280' },
                afterBuildTicks: (axis: any) => {
                    axis.ticks = Array.from({ length: 11 }, (_, i) => ({ value: i }));
                }
            },
            x: {
                grid: { display: false },
                ticks: { color: darkMode ? '#9ca3af' : '#6b7280' }
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: darkMode ? '#374151' : '#fff',
                titleColor: darkMode ? '#fff' : '#111827',
                bodyColor: darkMode ? '#d1d5db' : '#4b5563',
                borderColor: darkMode ? '#4b5563' : '#e5e7eb',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
            }
        }
    };





    return (
        <>
            {/* Pull-to-refresh indicator */}
            <div
                className="fixed left-1/2 z-[60] pointer-events-none flex flex-col items-center justify-center transition-all duration-200"
                style={{
                    top: 0,
                    transform: `translateX(-50%) translateY(${-48 + Math.min(pullProgress, 1.5) * 80}px) scale(${pullProgress > 0 ? 1 : 0.8})`,
                    opacity: pullProgress > 0 ? Math.min(pullProgress * 2, 1) : 0,
                    transition: isDischarging ? 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease-out' : 'none',
                }}
                onTransitionEnd={() => setIsDischarging(false)}
            >
                <svg
                    className={`w-8 h-8 text-gray-400 dark:text-gray-500 ${charged || isDischarging ? 'animate-spin' : ''}`}
                    viewBox="0 0 24 24"
                    style={{
                        transform: (!charged && !isDischarging) ? `rotate(${Math.min(pullProgress, 1) * 120}deg)` : undefined,
                        transition: (!charged && !isDischarging) ? 'transform 0.1s linear' : 'none',
                        filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))'
                    }}
                >
                    {Array.from({ length: 12 }).map((_, i) => (
                        <line
                            key={i}
                            x1="12" y1="2" x2="12" y2="6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            transform={`rotate(${i * 30} 12 12)`}
                            style={{ opacity: 1 - (i / 12) }}
                        />
                    ))}
                </svg>
            </div>

            <div className={`min-h-screen transition-colors duration-300 ${darkMode ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'} pb-12`}>
                <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'} shadow-sm sticky top-0 z-40 border-b transition-colors duration-300`}>
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
                        <div>
                            <h1 className={`text-2xl font-bold leading-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                                Hello 👋
                            </h1>
                            <p className="text-lg font-extrabold text-indigo-500">{studentInfo?.name || 'Student'}</p>
                        </div>
                        <div className="flex items-center gap-4">
                            <button
                                onClick={toggleTheme}
                                className={`p-3 rounded-full transition-all ${darkMode ? 'text-yellow-400 hover:bg-gray-700' : 'text-gray-400 hover:text-yellow-500 hover:bg-yellow-50'}`}
                                title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
                            >
                                {darkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
                            </button>
                            {'serviceWorker' in navigator && 'PushManager' in window && (
                                <button
                                    onClick={handleToggleNotifications}
                                    disabled={notifLoading}
                                    className={`p-3 rounded-full transition-all ${notifLoading ? 'opacity-50 cursor-wait' : ''} ${notifEnabled
                                        ? (darkMode ? 'text-yellow-400 hover:bg-gray-700' : 'text-yellow-500 hover:bg-yellow-50')
                                        : (darkMode ? 'text-gray-400 hover:text-yellow-400 hover:bg-gray-700' : 'text-gray-400 hover:text-yellow-500 hover:bg-yellow-50')
                                        }`}
                                    title={notifEnabled ? 'Disable Notifications' : 'Enable Notifications'}
                                >
                                    {notifEnabled ? <Bell className="w-6 h-6" /> : <BellOff className="w-6 h-6" />}
                                </button>
                            )}
                            <button
                                onClick={onRefresh}
                                className={`p-3 rounded-full transition-all ${darkMode ? 'text-gray-400 hover:text-blue-400 hover:bg-gray-700' : 'text-gray-400 hover:text-blue-500 hover:bg-blue-50'} ${isLoading || isBackgroundLoading ? 'animate-spin text-blue-500' : ''}`}
                                title="Refresh Grades"
                                disabled={isLoading}
                            >
                                <RefreshCw className="w-6 h-6" />
                            </button>
                            <button
                                onClick={onLogout}
                                className={`p-3 rounded-full transition-all ${darkMode ? 'text-gray-400 hover:text-red-400 hover:bg-gray-700' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'}`}
                                title="Logout"
                            >
                                <LogOut className="w-6 h-6" />
                            </button>
                        </div>
                    </div>
                </header>

                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="space-y-6 col-span-1">
                            <div className={`rounded-2xl shadow-sm border p-6 relative overflow-hidden transition-colors duration-300 flex flex-col items-center justify-center ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                                <GradeGauge grade={studentInfo?.average || ''} statusColor="text-indigo-500" darkMode={darkMode} size="medium" />
                            </div>

                            <div className={`rounded-2xl shadow-sm border p-6 flex flex-row items-center justify-around transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                                <div className="text-center px-4">
                                    <span className={`text-[11px] font-black uppercase tracking-[0.2em] mb-2 block ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Total ECTS</span>
                                    <span className={`text-3xl font-black ${darkMode ? 'text-white' : 'text-gray-900'}`}>{ectsInt(studentInfo?.totalCredits)}</span>
                                </div>
                                <div className={`w-px h-12 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}></div>
                                <div className="text-center px-4">
                                    <span className={`text-[11px] font-black uppercase tracking-[0.2em] mb-2 block ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Greek Credits</span>
                                    <span className={`text-3xl font-black ${darkMode ? 'text-gray-200' : 'text-gray-800'}`}>{ectsInt(studentInfo?.totalGreekCredits)}</span>
                                </div>
                                <div className={`w-px h-12 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}></div>
                                <div className="text-center px-4">
                                    <span className={`text-[11px] font-black uppercase tracking-[0.2em] mb-2 block ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Total Passed</span>
                                    <span className={`text-3xl font-black text-green-500`}>{allGrades.filter(g => getGradeStatus(g.grade) === 'passed').length}</span>
                                </div>
                            </div>
                        </div>

                        <div className={`rounded-2xl shadow-sm border p-6 flex flex-col items-center justify-center col-span-1 md:col-span-2 relative overflow-hidden transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                            <div className="w-full h-64 relative z-10">
                                <Pie data={metricsData} options={pieOptions} plugins={[ChartDataLabels]} />
                            </div>
                            <div className={`absolute top-0 right-0 -mt-10 -mr-10 w-40 h-40 rounded-full opacity-50 z-0 ${darkMode ? 'bg-blue-900/20' : 'bg-blue-50'}`}></div>
                        </div>
                    </div>

                    <div className={`rounded-2xl shadow-sm border p-6 min-h-[300px] transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                        <h3 className={`text-lg font-semibold mb-6 ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>Performance History</h3>
                        <div className="h-64 w-full">
                            <Bar data={barChartData} options={barOptions} />
                        </div>
                    </div>

                    <div className="space-y-12">
                        {gradesBySemester.map((group: { semester: number; grades: Grade[] }) => (
                            <div key={group.semester} className="space-y-6">
                                <div className="flex items-center gap-4">
                                    <h3 className={`text-xl font-bold tracking-tight ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>
                                        Semester {group.semester === 0 ? 'Other' : group.semester}
                                    </h3>
                                    <div className={`flex-1 h-px ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}></div>
                                </div>

                                <div className="grid grid-cols-1 gap-4">
                                    {group.grades.map((g: Grade) => {
                                        const status = getGradeStatus(g.grade);
                                        const statusColor = getStatusColor(status, darkMode, true);

                                        return (
                                            <button
                                                key={g.code}
                                                onClick={() => { if (!scrollingRef.current) onSelectCourse(g.code); }}
                                                className={`group relative p-4 rounded-2xl border text-left transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 ${darkMode ? 'bg-gray-800 border-gray-700 hover:border-gray-600' : 'bg-white border-gray-100'}
                                                ${status === 'passed' ? (darkMode ? 'hover:border-green-800/50' : 'hover:border-green-100') : ''}
                                                ${status === 'failed' ? (darkMode ? 'hover:border-red-800/50' : 'hover:border-red-100') : ''}
                                            `}
                                            >
                                                <div className="flex items-center justify-between gap-4">
                                                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                                                        <span className={`text-[10px] font-bold uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                                                            {g.code}
                                                        </span>
                                                        <h4 className={`text-base font-bold leading-tight truncate ${statusColor}`}>
                                                            {g.title}
                                                        </h4>
                                                        <div className={`text-xs font-medium truncate ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                                                            {g.apprStatus ? `${(g.acadSession || '').replace(/Εξάμηνο/gi, '').trim()} ${g.year} | ${g.apprStatus}` : '—'}
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col items-center justify-center shrink-0 w-20">
                                                        <span className={`text-2xl font-black ${statusColor}`}>
                                                            {g.grade || '—'}
                                                        </span>
                                                    </div>
                                                </div>

                                                {g.isNew && (
                                                    <div className="absolute top-5 right-5 h-2.5 w-2.5">
                                                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                                                    </div>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                </main>
            </div>
            <AnimatePresence>
                {selectedCourseCode && selectedCourseData && (
                    <CourseDetailView
                        data={selectedCourseData}
                        darkMode={darkMode}
                        onSelectCourse={onSelectCourse}
                        detailRef={detailRef}
                        barOptions={barOptions}
                        stripAccents={stripAccents}
                        animateOut={animateOut}
                    />
                )}
            </AnimatePresence>
        </>
    );
};

const GradeGauge: React.FC<{ grade: string; statusColor: string; darkMode: boolean; size?: 'small' | 'medium' | 'large' }> = ({ grade, statusColor, darkMode, size = 'large' }) => {
    const val = parseFloat(grade.replace(',', '.'));
    const isNumber = !isNaN(val);
    const percentage = isNumber ? Math.min(Math.max(val / 10, 0), 1) : 0;

    const isSmall = size === 'small';
    const isMedium = size === 'medium';
    const containerClass = isSmall ? 'w-36 h-36' : isMedium ? 'w-64 h-64' : 'w-80 h-80';
    const radius = isSmall ? 52 : isMedium ? 100 : 124;
    const viewBox = isSmall ? '0 0 160 160' : isMedium ? '0 0 280 280' : '0 0 350 350';
    const center = isSmall ? 80 : isMedium ? 140 : 175;
    const strokeW = isSmall ? 8 : isMedium ? 18 : 22;
    const textSize = isSmall ? 'text-4xl' : isMedium ? 'text-4xl' : 'text-7xl';
    const nsRingRadius = radius - strokeW - 4; // Inside the gauge

    const topY = center - radius;
    const bottomY = center + radius;

    return (
        <div className={`relative ${containerClass} flex items-center justify-center`}>
            <svg className="w-full h-full drop-shadow-md" viewBox={viewBox}>
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={darkMode ? "#374151" : "#E5E7EB"}
                    strokeWidth={strokeW}
                    strokeLinecap="round"
                />

                {!isNumber && grade && grade.trim() && (
                    <circle
                        cx={center}
                        cy={center}
                        r={nsRingRadius}
                        fill="none"
                        stroke={darkMode ? "rgba(239, 68, 68, 0.4)" : "rgba(239, 68, 68, 0.3)"}
                        strokeWidth="2"
                        strokeDasharray="4 4"
                        className="animate-pulse"
                    />
                )}

                {isNumber && (
                    <>
                        <motion.path
                            d={`M ${center} ${topY} A ${radius} ${radius} 0 0 1 ${center} ${bottomY}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={strokeW}
                            strokeLinecap="round"
                            className={statusColor}
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: percentage }}
                            transition={{ duration: 0.8, ease: [0.95, 0.05, 0.795, 0.035] }}
                        />
                        <motion.path
                            d={`M ${center} ${topY} A ${radius} ${radius} 0 0 0 ${center} ${bottomY}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={strokeW}
                            strokeLinecap="round"
                            className={statusColor}
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: percentage }}
                            transition={{ duration: 0.8, ease: [0.95, 0.05, 0.795, 0.035] }}
                        />
                    </>
                )}
            </svg>

            <div className="absolute inset-0 flex items-center justify-center flex-col">
                <span className={`${textSize} font-black ${statusColor} tracking-tighter`}>
                    {grade || '—'}
                </span>
                {isNumber && (
                    <span className={`text-[15px] font-black uppercase tracking-[0.3em] mt-3 mr-[-0.3em] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        {(isSmall || isMedium) ? 'AVG' : 'Grade'}
                    </span>
                )}
            </div>
        </div>
    );
};
