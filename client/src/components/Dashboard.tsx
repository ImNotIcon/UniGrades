import React, { useMemo, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title, PointElement, LineElement, Filler } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Pie, Bar } from 'react-chartjs-2';
import { LogOut, RefreshCw, Moon, Sun, Settings, Home, List, Search, Filter, X, ChevronRight } from 'lucide-react';
import type { Grade, StudentInfo } from '../types';
import { SettingsModal } from './SettingsModal';

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
    apiUrl: string;
    username: string;
    deviceId: string;
    deviceModel: string;
    autoSolveEnabled: boolean;
    onAutoSolveChange: (enabled: boolean) => void;
    passwordBase64: string | null;
    mongoEnabled: boolean;
    pushEnabled: boolean;
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




// Logic for getting status color and other helpers


// Tab components

const COLORS = ['#10B981', '#EF4444', '#6B7280']; // Green, Red, Gray

const HomeTab: React.FC<{
    studentInfo: StudentInfo | null;
    allGrades: Grade[];
    fullHistory: Grade[];
    metricsData: any;
    pieOptions: any;
    barChartData: any;
    barOptions: any;
    darkMode: boolean;
    onViewAll: () => void;
    onSelectCourse: (code: string | null) => void;
    scrollingRef: React.MutableRefObject<boolean>;
}> = ({ studentInfo, allGrades, fullHistory, metricsData, pieOptions, barChartData, barOptions, darkMode, onViewAll, onSelectCourse, scrollingRef }) => {
    const recentGrades = useMemo(() => {
        return [...fullHistory]
            .sort((a, b) => {
                const yearA = parseInt(a.year.split('-')[0]) || 0;
                const yearB = parseInt(b.year.split('-')[0]) || 0;
                if (yearA !== yearB) return yearB - yearA;
                const semA = parseInt(a.semester) || 0;
                const semB = parseInt(b.semester) || 0;
                return semB - semA;
            })
            .slice(0, 5);
    }, [fullHistory]);

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-6 col-span-1">
                    <div className={`rounded-3xl shadow-sm border p-6 relative overflow-hidden transition-colors duration-300 flex flex-col items-center justify-center ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                        <GradeGauge grade={studentInfo?.average || ''} statusColor="text-indigo-500" darkMode={darkMode} size="medium" />
                    </div>

                    <div className={`rounded-3xl shadow-sm border p-6 flex flex-row items-center justify-around transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                        <div className="text-center px-4">
                            <span className={`text-[11px] font-black uppercase tracking-[0.2em] mb-2 block ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Total ECTS</span>
                            <span className={`text-3xl font-black ${darkMode ? 'text-white' : 'text-gray-900'}`}>{ectsInt(studentInfo?.totalCredits)}</span>
                        </div>
                        <div className={`w-px h-12 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}></div>
                        <div className="text-center px-4">
                            <span className={`text-[11px] font-black uppercase tracking-[0.2em] mb-2 block ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Total Passed</span>
                            <span className={`text-3xl font-black text-green-500`}>{allGrades.filter(g => getGradeStatus(g.grade) === 'passed').length}</span>
                        </div>
                    </div>
                </div>

                <div className={`rounded-3xl shadow-sm border p-6 flex flex-col items-center justify-center col-span-1 md:col-span-2 relative overflow-hidden transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                    <div className="w-full h-64 relative z-10">
                        <Pie data={metricsData} options={pieOptions} plugins={[ChartDataLabels]} />
                    </div>
                    <div className={`absolute top-0 right-0 -mt-10 -mr-10 w-40 h-40 rounded-full opacity-50 z-0 ${darkMode ? 'bg-blue-900/10' : 'bg-blue-50'}`}></div>
                </div>
            </div>

            {/* Recent Grades Section */}
            <div className={`rounded-3xl shadow-sm border p-6 transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                <div className="flex items-center justify-between mb-6">
                    <h3 className={`text-lg font-black uppercase tracking-tight ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>Recent Grades</h3>
                    <button
                        onClick={onViewAll}
                        className="flex items-center gap-1 text-sm font-bold text-indigo-500 hover:text-indigo-400 transition-colors"
                    >
                        View All <ChevronRight className="w-4 h-4" />
                    </button>
                </div>

                {recentGrades.length === 0 ? (
                    <div className="py-12 text-center opacity-50 font-medium">No recent grades to show.</div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                        {recentGrades.map((g) => {
                            const status = getGradeStatus(g.grade);
                            const statusColor = getStatusColor(status, darkMode, true);
                            return (
                                <button
                                    key={`${g.code}-${g.year}-${g.semester}`}
                                    onClick={() => { if (!scrollingRef.current) onSelectCourse(g.code); }}
                                    className={`p-4 rounded-2xl border text-left transition-all hover:shadow-md ${darkMode ? 'bg-gray-900/50 border-gray-700' : 'bg-gray-50 border-gray-100'}`}
                                >
                                    <div className="flex flex-col gap-1">
                                        <span className={`text-[10px] font-bold uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>{g.code}</span>
                                        <h4 className="text-sm font-bold truncate leading-tight">{g.title}</h4>
                                        <div className="flex items-center justify-between mt-2">
                                            <span className="text-xs font-semibold opacity-50">{g.year}</span>
                                            <span className={`text-lg font-black ${statusColor}`}>{g.grade || '—'}</span>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className={`rounded-3xl shadow-sm border p-6 min-h-[300px] transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                <h3 className={`text-lg font-black uppercase tracking-tight mb-8 ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>Performance History</h3>
                <div className="h-64 w-full">
                    <Bar data={barChartData} options={barOptions} />
                </div>
            </div>
        </div>
    );
};

const GradesTab: React.FC<{
    allGrades: Grade[];
    searchTerm: string;
    setSearchTerm: (s: string) => void;
    filters: { passed: boolean; failed: boolean; noGrade: boolean };
    onOpenFilters: () => void;
    onSelectCourse: (code: string | null) => void;
    scrollingRef: React.MutableRefObject<boolean>;
    darkMode: boolean;
}> = ({ allGrades, searchTerm, setSearchTerm, filters, onOpenFilters, onSelectCourse, scrollingRef, darkMode }) => {
    const sectionRefs = React.useRef<Record<number, HTMLDivElement | null>>({});
    const [currentSection, setCurrentSection] = useState<number | null>(null);
    const tabsContainerRef = React.useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (currentSection !== null && tabsContainerRef.current) {
            const activeBtn = tabsContainerRef.current.querySelector('[data-active="true"]');
            if (activeBtn) {
                activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
            }
        }
    }, [currentSection]);

    const filteredGrades = useMemo(() => {
        return allGrades.filter(g => {
            const matchesSearch =
                g.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                g.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (g.grade || '').includes(searchTerm);

            const status = getGradeStatus(g.grade);
            const hasActiveFilter = filters.passed || filters.failed || filters.noGrade;
            const matchesFilter = !hasActiveFilter || (
                (filters.passed && status === 'passed') ||
                (filters.failed && status === 'failed') ||
                (filters.noGrade && status === 'neutral')
            );

            return matchesSearch && matchesFilter;
        });
    }, [allGrades, searchTerm, filters]);

    const semesterGroups = useMemo(() => {
        const groups = new Map<number, { grades: Grade[]; avg: number }>();
        filteredGrades.forEach((g: Grade) => {
            const sem = parseInt(g.semester) || 0;
            if (!groups.has(sem)) groups.set(sem, { grades: [], avg: 0 });
            groups.get(sem)?.grades.push(g);
        });

        // Calculate averages
        groups.forEach((val) => {
            const validGrades = val.grades
                .map(g => parseFloat(g.grade.replace(',', '.')))
                .filter(v => !isNaN(v));
            val.avg = validGrades.length > 0
                ? parseFloat((validGrades.reduce((a, b) => a + b, 0) / validGrades.length).toFixed(2))
                : 0;
        });

        const sortedKeys = Array.from(groups.keys()).sort((a, b) => b - a);
        return sortedKeys.map(key => ({
            semester: key,
            grades: groups.get(key)?.grades || [],
            average: groups.get(key)?.avg || 0
        }));
    }, [filteredGrades]);

    useEffect(() => {
        const handleScroll = () => {
            const scrollPos = window.scrollY + 200;
            let bestMatch: number | null = null;

            Object.entries(sectionRefs.current).forEach(([sem, el]) => {
                if (el && el.offsetTop <= scrollPos) {
                    bestMatch = parseInt(sem);
                }
            });

            setCurrentSection(bestMatch);
        };

        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const scrollToSemester = (sem: number) => {
        const el = sectionRefs.current[sem];
        if (el) {
            const offset = el.offsetTop - 140;
            window.scrollTo({ top: offset, behavior: 'smooth' });
        }
    };

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
            <div className="sticky top-[108px] z-30 -mx-4 px-4 py-2 bg-gray-50/80 dark:bg-gray-900/80 backdrop-blur-md">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-2xl font-black uppercase tracking-tight">Grades</h2>
                    <button
                        onClick={onOpenFilters}
                        className={`p-2 rounded-xl transition-all ${Object.values(filters).some(Boolean) ? 'bg-indigo-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-400'}`}
                    >
                        <Filter className="w-5 h-5" />
                    </button>
                </div>
                <div className="relative mb-4">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search by title, code or grade..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className={`w-full pl-12 pr-4 py-3 rounded-2xl border transition-all outline-none focus:ring-2 focus:ring-indigo-500/20 ${darkMode ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-500' : 'bg-white border-gray-100 text-gray-900 placeholder-gray-400'}`}
                    />
                </div>

                {semesterGroups.length > 0 && window.scrollY > 100 && (
                    <div ref={tabsContainerRef} className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide no-scrollbar">
                        {semesterGroups.map(g => (
                            <button
                                key={g.semester}
                                data-active={currentSection === g.semester}
                                onClick={() => scrollToSemester(g.semester)}
                                className={`shrink-0 px-4 py-2 rounded-full text-xs font-black uppercase tracking-wider transition-all ${currentSection === g.semester ? 'bg-indigo-500 text-white shadow-lg' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                            >
                                Sem {g.semester === 0 ? 'Other' : g.semester}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="space-y-12">
                {semesterGroups.map((group) => (
                    <div
                        key={group.semester}
                        ref={el => { sectionRefs.current[group.semester] = el; }}
                        className="space-y-6 scroll-mt-40"
                    >
                        <div className="flex items-center justify-between">
                            <h3 className={`text-xl font-black uppercase tracking-tight ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>
                                Semester {group.semester === 0 ? 'Other' : group.semester}
                            </h3>
                            {group.average > 0 && (
                                <span className="text-sm font-black text-indigo-500 px-3 py-1 bg-indigo-500/10 rounded-lg">
                                    AVG: {group.average}
                                </span>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-4">
                            {group.grades.map((g: Grade) => {
                                const status = getGradeStatus(g.grade);
                                const statusColor = getStatusColor(status, darkMode, true);
                                return (
                                    <button
                                        key={`${g.code}-${g.year}-${g.semester}`}
                                        onClick={() => { if (!scrollingRef.current) onSelectCourse(g.code); }}
                                        className={`group relative p-5 rounded-2xl border text-left transition-all duration-300 hover:shadow-lg ${darkMode ? 'bg-gray-800 border-gray-700 hover:border-gray-600' : 'bg-white border-gray-100 hover:border-gray-200'}`}
                                    >
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="flex-1 min-w-0">
                                                <span className={`text-[10px] font-black uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                                                    {g.code}
                                                </span>
                                                <h4 className="text-base font-black leading-tight truncate mt-1">
                                                    {g.title}
                                                </h4>
                                                <div className="text-xs font-bold opacity-40 mt-1 truncate">
                                                    {g.apprStatus ? `${g.year} | ${g.apprStatus}` : g.year}
                                                </div>
                                            </div>
                                            <div className="shrink-0 w-16 text-center">
                                                <span className={`text-2xl font-black ${statusColor}`}>
                                                    {g.grade || '—'}
                                                </span>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}

                {semesterGroups.length === 0 && (
                    <div className="py-20 text-center flex flex-col items-center gap-4 opacity-30">
                        <Search className="w-12 h-12" />
                        <p className="font-bold">No grades found matching your criteria.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

const FilterBottomSheet: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    tempFilters: { passed: boolean; failed: boolean; noGrade: boolean };
    setTempFilters: React.Dispatch<React.SetStateAction<{ passed: boolean; failed: boolean; noGrade: boolean }>>;
    onApply: () => void;
    onRestore: () => void;
    darkMode: boolean;
}> = ({ isOpen, onClose, tempFilters, setTempFilters, onApply, onRestore, darkMode }) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/50 z-[60] backdrop-blur-sm"
                    />
                    <motion.div
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className={`fixed bottom-0 left-0 right-0 z-[70] p-8 rounded-t-[3rem] shadow-2xl ${darkMode ? 'bg-gray-800' : 'bg-white'}`}
                    >
                        <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-8 opacity-20" />
                        <h3 className="text-xl font-black uppercase tracking-tight mb-8">Filter Grades</h3>

                        <div className="space-y-4 mb-10">
                            {[
                                { id: 'passed', label: 'Passed Only', color: 'text-green-500' },
                                { id: 'failed', label: 'Failed Only', color: 'text-red-500' },
                                { id: 'noGrade', label: 'No Grade', color: 'text-gray-400' }
                            ].map(opt => (
                                <button
                                    key={opt.id}
                                    onClick={() => setTempFilters(prev => ({ ...prev, [opt.id]: !prev[opt.id as keyof typeof prev] }))}
                                    className={`w-full flex items-center justify-between p-5 rounded-2xl transition-all border-2 ${tempFilters[opt.id as keyof typeof tempFilters] ? 'border-indigo-500 bg-indigo-500/5' : 'border-transparent bg-gray-50 dark:bg-gray-900/50'}`}
                                >
                                    <span className={`font-black uppercase tracking-wider ${opt.color}`}>{opt.label}</span>
                                    <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${tempFilters[opt.id as keyof typeof tempFilters] ? 'bg-indigo-500 text-white' : 'border-2 border-gray-200 dark:border-gray-700'}`}>
                                        {tempFilters[opt.id as keyof typeof tempFilters] && (
                                            <X className="w-4 h-4" />
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <div className="flex gap-4">
                            <button
                                onClick={onRestore}
                                className="flex-1 py-4 font-black uppercase tracking-widest text-gray-400 bg-gray-100 dark:bg-gray-700 rounded-2xl hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                            >
                                Restore
                            </button>
                            <button
                                onClick={onApply}
                                className="flex-1 py-4 font-black uppercase tracking-widest text-white bg-indigo-500 rounded-2xl shadow-lg shadow-indigo-500/20 hover:bg-indigo-600 transition-colors"
                            >
                                Apply
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};
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
    apiUrl,
    username,
    deviceId,
    deviceModel,
    autoSolveEnabled,
    onAutoSolveChange,
    passwordBase64,
    mongoEnabled,
    pushEnabled,
}) => {
    const detailRef = React.useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState<'home' | 'grades'>('home');
    const [searchTerm, setSearchTerm] = useState('');
    const [filters, setFilters] = useState({ passed: false, failed: false, noGrade: false });
    const [filtersTemp, setFiltersTemp] = useState({ passed: false, failed: false, noGrade: false });
    const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const scrollingRef = React.useRef(false);
    const scrollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
                    label: 'Background',
                    data: dataPoints.map(() => 10),
                    backgroundColor: darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
                    borderRadius: 20,
                    borderSkipped: false,
                    barThickness: 20,
                },
                {
                    label: 'Average Grade',
                    data: dataPoints.map(d => d.avg),
                    backgroundColor: '#6366f1',
                    borderRadius: 20,
                    borderSkipped: false,
                    barThickness: 20,
                },
            ],
        };
    }, [allGrades, darkMode]);

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
                formatter: (value: number, ctx: unknown) => {
                    if (value <= 0) return '';
                    const typedCtx = ctx as { chart?: { data?: { labels?: unknown[] } }; dataIndex?: number };
                    const labels = typedCtx.chart?.data?.labels || [];
                    const label = labels[typedCtx.dataIndex || 0] || '';
                    return `${label}\n${value}`;
                },
                textAlign: 'center' as const,
            }
        }
    };

    const barOptions = {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
            padding: { top: 20 }
        },
        scales: {
            y: {
                min: 4,
                max: 10,
                display: false,
                grid: { display: false },
                stacked: false
            },
            x: {
                grid: { display: false },
                ticks: {
                    color: darkMode ? '#9ca3af' : '#6b7280',
                    font: { weight: 'bold' }
                },
                stacked: true
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: true,
                backgroundColor: darkMode ? '#374151' : '#fff',
                titleColor: darkMode ? '#fff' : '#111827',
                bodyColor: darkMode ? '#d1d5db' : '#4b5563',
                borderColor: darkMode ? '#4b5563' : '#e5e7eb',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                    label: (context: any) => {
                        if (context.datasetIndex === 0) return "";
                        return `Average: ${context.parsed.y}`;
                    }
                }
            },
            datalabels: {
                display: (context: any) => context.datasetIndex === 1,
                color: darkMode ? '#fff' : '#111827',
                anchor: 'end' as const,
                align: 'top' as const,
                font: { weight: 'bold' as const, size: 12 },
                formatter: (value: number) => value > 0 ? value.toString() : ''
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
                            {mongoEnabled && (
                                <button
                                    onClick={() => setSettingsOpen(true)}
                                    className={`p-3 rounded-full transition-all ${darkMode ? 'text-gray-400 hover:text-indigo-300 hover:bg-gray-700' : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50'}`}
                                    title="Settings"
                                >
                                    <Settings className="w-6 h-6" />
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

                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 flex-1 overflow-y-auto no-scrollbar">
                    {activeTab === 'home' ? (
                        <HomeTab
                            studentInfo={studentInfo}
                            allGrades={allGrades}
                            fullHistory={fullHistory}
                            metricsData={metricsData}
                            pieOptions={pieOptions}
                            barChartData={barChartData}
                            barOptions={barOptions}
                            darkMode={darkMode}
                            onViewAll={() => setActiveTab('grades')}
                            onSelectCourse={onSelectCourse}
                            scrollingRef={scrollingRef}
                        />
                    ) : (
                        <GradesTab
                            allGrades={allGrades}
                            searchTerm={searchTerm}
                            setSearchTerm={setSearchTerm}
                            filters={filters}
                            onOpenFilters={() => {
                                setFiltersTemp(filters);
                                setIsFilterMenuOpen(true);
                            }}
                            onSelectCourse={onSelectCourse}
                            scrollingRef={scrollingRef}
                            darkMode={darkMode}
                        />
                    )}

                    {/* Bottom Navigation */}
                    <div className={`fixed bottom-0 left-0 right-0 z-40 border-t flex items-center justify-around px-6 py-2 transition-colors duration-300 ${darkMode ? 'bg-gray-800/90 border-gray-700' : 'bg-white/90 border-gray-100'} backdrop-blur-md`}>
                        <button
                            onClick={() => setActiveTab('home')}
                            className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${activeTab === 'home' ? 'text-indigo-500' : 'text-gray-400'}`}
                        >
                            <Home className={`w-6 h-6 ${activeTab === 'home' ? 'fill-indigo-500/10' : ''}`} />
                            <span className="text-[10px] font-bold uppercase tracking-wider">Home</span>
                        </button>
                        <button
                            onClick={() => setActiveTab('grades')}
                            className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${activeTab === 'grades' ? 'text-indigo-500' : 'text-gray-400'}`}
                        >
                            <List className={`w-6 h-6 ${activeTab === 'grades' ? 'fill-indigo-500/10' : ''}`} />
                            <span className="text-[10px] font-bold uppercase tracking-wider">Grades</span>
                        </button>
                    </div>

                    <FilterBottomSheet
                        isOpen={isFilterMenuOpen}
                        onClose={() => setIsFilterMenuOpen(false)}
                        tempFilters={filtersTemp}
                        setTempFilters={setFiltersTemp}
                        onApply={() => {
                            setFilters(filtersTemp);
                            setIsFilterMenuOpen(false);
                        }}
                        onRestore={() => {
                            const reset = { passed: false, failed: false, noGrade: false };
                            setFilters(reset);
                            setFiltersTemp(reset);
                            setIsFilterMenuOpen(false);
                        }}
                        darkMode={darkMode}
                    />
                    <div className="pb-24" />
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

            <AnimatePresence>
                {settingsOpen && (
                    <SettingsModal
                        isOpen={settingsOpen}
                        onClose={() => setSettingsOpen(false)}
                        apiUrl={apiUrl}
                        darkMode={darkMode}
                        mongoEnabled={mongoEnabled}
                        pushEnabled={pushEnabled}
                        username={username}
                        deviceId={deviceId}
                        deviceModel={deviceModel}
                        autoSolveEnabled={autoSolveEnabled}
                        onAutoSolveChange={onAutoSolveChange}
                        passwordBase64={passwordBase64}
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

const CourseDetailView: React.FC<{
    data: { latest: Grade; history: Grade[] };
    darkMode: boolean;
    onSelectCourse: (code: string | null) => void;
    detailRef: React.RefObject<HTMLDivElement | null>;
    barOptions: any;
    stripAccents: (s: string | undefined) => string;
    animateOut: boolean;
}> = ({ data, darkMode, onSelectCourse, detailRef, barOptions, stripAccents, animateOut }) => {
    const { latest, history } = data;
    const status = getGradeStatus(latest.grade);
    const statusColor = getStatusColor(status, darkMode, true);

    const historyChartData = {
        labels: history.map(h => h.acadSession || h.year),
        datasets: [{
            label: 'Grade History',
            data: history.map(h => parseFloat(h.grade.replace(',', '.')) || 0),
            backgroundColor: '#6366f1',
            borderRadius: 8,
            barThickness: 24,
        }]
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={animateOut ? { opacity: 0 } : undefined}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
            onClick={() => onSelectCourse(null)}
        >
            <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className={`relative w-full max-w-2xl h-[90vh] sm:h-auto sm:max-h-[85vh] overflow-hidden rounded-t-[2.5rem] sm:rounded-[2.5rem] shadow-2xl ${darkMode ? 'bg-gray-900 border-gray-800' : 'bg-white border-gray-100 shadow-xl'}`}
                onClick={e => e.stopPropagation()}
            >
                <div ref={detailRef} className="h-full overflow-y-auto no-scrollbar p-8 pb-12">
                    <div className="flex justify-between items-start mb-8">
                        <div>
                            <span className={`text-xs font-black uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                                {latest.code}
                            </span>
                            <h2 className="text-2xl font-black leading-tight mt-1">{latest.title}</h2>
                        </div>
                        <button
                            onClick={() => onSelectCourse(null)}
                            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mb-8">
                        <div className={`p-6 rounded-3xl border ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200 shadow-sm'}`}>
                            <span className="text-[10px] font-black uppercase tracking-widest opacity-40 mb-2 block">Current Grade</span>
                            <span className={`text-4xl font-black ${statusColor}`}>{latest.grade || '—'}</span>
                        </div>
                        <span className={`text-lg font-black uppercase ${statusColor}`}>{status}</span>
                    </div>
                </div>

                <div className="mb-8">
                    <h3 className="text-sm font-black uppercase tracking-widest opacity-40 mb-4 px-1">{stripAccents('Ιστορικό')}</h3>
                    <div className="h-48 w-full p-4 rounded-3xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
                        <Bar data={historyChartData} options={barOptions} />
                    </div>
                </div>

                <div className="space-y-3">
                    <h3 className="text-sm font-black uppercase tracking-widest opacity-40 mb-4 px-1">{stripAccents('Πληροφορίες')}</h3>
                    {[
                        { label: 'Academic Session', value: latest.acadSession },
                        { label: 'Year', value: latest.year },
                        { label: 'Evaluation Method', value: latest.evalMethod },
                        { label: 'Approval Status', value: latest.apprStatus }
                    ].map((item, idx) => item.value && (
                        <div key={idx} className="flex justify-between items-center py-4 border-b border-gray-100 dark:border-gray-800 last:border-0 px-1">
                            <span className="text-sm font-bold opacity-50">{item.label}</span>
                            <span className="text-sm font-black">{item.value}</span>
                        </div>
                    ))}
                </div>
            </motion.div>
        </motion.div>
    );
};
