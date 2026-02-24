import React, { useMemo, useEffect, useState } from 'react';
import { motion, AnimatePresence, useDragControls, useMotionValue, animate } from 'framer-motion';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title, PointElement, LineElement, Filler } from 'chart.js';
import type { ChartData, ChartOptions } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Doughnut, Bar, Line } from 'react-chartjs-2';
import { LogOut, RefreshCw, Settings, Home, List, Search, Filter, X, ChevronRight, ArrowLeft } from 'lucide-react';
import PullToRefresh, { type PullToRefreshInstance } from 'pulltorefreshjs';
import type { Grade, StudentInfo } from '../types';
import { SettingsModal } from './SettingsModal';

const RoundedDonutPlugin = {
    id: 'roundedDonutPlugin',
    afterDatasetsDraw: (chart: any) => {
        const ds = chart?.data?.datasets?.[0];
        if (!ds) return;

        const data = (Array.isArray(ds.data) ? ds.data : []).map((v: unknown) => (typeof v === 'number' ? v : Number(v) || 0));
        const total = data.reduce((sum: number, v: number) => sum + v, 0);
        if (total <= 0) return;

        const meta = chart.getDatasetMeta(0);
        const firstArc = meta?.data?.[0];
        if (!firstArc) return;

        const ctx = chart.ctx as CanvasRenderingContext2D;
        const { x, y, innerRadius, outerRadius } = firstArc;
        const thickness = outerRadius - innerRadius;
        const radius = innerRadius + thickness / 2;
        const rotation = typeof chart.options?.rotation === 'number' ? chart.options.rotation : -0.5 * Math.PI;
        const tau = Math.PI * 2;
        const colors = ds.segmentColors || ['#6B7280', '#10B981', '#EF4444'];

        let cursor = rotation;
        ctx.save();
        ctx.lineWidth = thickness;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        data.forEach((value: number, i: number) => {
            if (value <= 0) return;
            const segAngle = (value / total) * tau;
            const capStart = (thickness / 2) / radius;
            const overlap = Math.min(capStart, segAngle * 0.28);
            const start = cursor - overlap;
            const end = cursor + segAngle + overlap;

            ctx.beginPath();
            ctx.strokeStyle = colors[i] || '#9ca3af';
            ctx.arc(x, y, radius, start, end);
            ctx.stroke();

            cursor += segAngle;
        });

        ctx.restore();
    }
};

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title, PointElement, LineElement, Filler, ChartDataLabels, RoundedDonutPlugin);

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
    autoSolveAvailable: boolean;
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

const hasVisibleGrade = (grade: string | undefined) => typeof grade === 'string' && grade.trim() !== '';

const NoGradePill: React.FC<{ darkMode: boolean; compact?: boolean; gauge?: boolean }> = ({ darkMode, compact = false, gauge = false }) => (
    <span
        title="No grade"
        className={`inline-flex rounded-full ${gauge ? 'h-3.5 w-[5.5rem]' : compact ? 'h-1.5 w-7' : 'h-[0.45rem] w-9'} ${darkMode ? 'bg-gray-600' : 'bg-gray-300'}`}
    />
);




const GradeCard: React.FC<{
    grade: Grade;
    darkMode: boolean;
    onSelect: (code: string) => void;
    scrollingRef: React.MutableRefObject<boolean>;
    isHome?: boolean;
}> = ({ grade, darkMode, onSelect, scrollingRef, isHome }) => {
    const status = getGradeStatus(grade.grade);
    const statusColor = getStatusColor(status, darkMode, true);

    const bgClass = darkMode
        ? (isHome ? 'bg-gray-900/50 border-gray-800' : 'bg-gray-800 border-gray-700')
        : 'bg-gray-100 border-gray-200';

    return (
        <button
            onClick={() => { if (!scrollingRef.current) onSelect(grade.code); }}
            className={`group relative p-5 rounded-2xl border text-left transition-all duration-300 hover:shadow-lg ${bgClass} ${darkMode ? 'hover:border-gray-600' : 'hover:border-gray-400'}`}
        >
            <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                    <span className={`text-[10px] font-black uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        {grade.code}
                    </span>
                    <h4 className="text-base font-black leading-tight truncate mt-1">
                        {grade.title}
                    </h4>
                    <div className="text-xs font-bold opacity-40 mt-1 truncate">
                        {grade.apprStatus ? `${grade.year} | ${grade.apprStatus}` : grade.year}
                    </div>
                </div>
                <div className="shrink-0 w-20 text-right relative">
                    <div className="relative inline-block">
                        <span className={`text-2xl font-black ${statusColor}`}>
                            {hasVisibleGrade(grade.grade) ? grade.grade : <NoGradePill darkMode={darkMode} />}
                        </span>
                        {grade.isNew && (
                            <span className="absolute -top-1 -right-2 flex h-2 w-2">
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </button>
    );
};

// Tab components

const HomeTab: React.FC<{
    studentInfo: StudentInfo | null;
    allGrades: Grade[];
    fullHistory: Grade[];
    metricsData: unknown;
    pieOptions: unknown;
    barChartData: unknown;
    barOptions: unknown;
    darkMode: boolean;
    onMetricFilterSelect: (key: 'passed' | 'failed' | 'noGrade') => void;
    onViewAll: () => void;
    onSelectCourse: (code: string | null) => void;
    scrollingRef: React.MutableRefObject<boolean>;
}> = ({ studentInfo, allGrades, fullHistory, metricsData, pieOptions, barChartData, barOptions, darkMode, onMetricFilterSelect, onViewAll, onSelectCourse, scrollingRef }) => {
    const recentGrades = useMemo(() => {
        return [...fullHistory]
            .filter(g => !!g.dateAdded)
            .sort((a, b) => {
                const timeA = new Date(a.dateAdded || 0).getTime();
                const timeB = new Date(b.dateAdded || 0).getTime();
                if (timeB !== timeA) return timeB - timeA;
                // Fallback for same-batch updates
                if (b.year !== a.year) return b.year.localeCompare(a.year);
                return b.code.localeCompare(a.code);
            })
            .slice(0, 5); // Show up to 5 instead of 3 to be more helpful
    }, [fullHistory]);
    const donutLegendItems = useMemo(() => {
        let passed = 0;
        let failed = 0;
        let noGrade = 0;
        allGrades.forEach((g: Grade) => {
            const status = getGradeStatus(g.grade);
            if (status === 'passed') passed++;
            else if (status === 'failed') failed++;
            else noGrade++;
        });
        return [
            { key: 'passed' as const, label: 'Passed', value: passed, dotClass: 'bg-emerald-500' },
            { key: 'failed' as const, label: 'Failed', value: failed, dotClass: 'bg-rose-500' },
            { key: 'noGrade' as const, label: 'No grade', value: noGrade, dotClass: 'bg-gray-500' },
        ];
    }, [allGrades]);

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-6">
                <div className="space-y-6 col-span-1 md:col-span-3">
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

                <div className={`rounded-3xl shadow-sm border p-6 flex flex-col items-center justify-center col-span-1 md:col-span-3 relative overflow-hidden transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                    <div className="w-full h-64 relative z-10 flex items-stretch gap-4">
                        <div className="w-60 md:w-64 h-full shrink-0">
                            <Doughnut
                                data={metricsData as ChartData<'doughnut', number[], string>}
                                options={pieOptions as ChartOptions<'doughnut'>}
                            />
                        </div>
                        <div className="flex-1 h-full flex flex-col justify-between py-1">
                            {donutLegendItems.map((item) => (
                                <button
                                    key={item.key}
                                    onClick={() => onMetricFilterSelect(item.key)}
                                    className={`w-full text-left rounded-xl px-3 py-2 transition-colors ${darkMode ? 'hover:bg-gray-700/50' : 'hover:bg-gray-100'}`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${item.dotClass}`} />
                                        <span className={`text-base ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>{item.label}</span>
                                    </div>
                                    <div className={`pl-4 text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>{item.value}</div>
                                </button>
                            ))}
                        </div>
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
                    <div className="py-12 text-center opacity-50 font-medium">No new grades yet.</div>
                ) : (
                    <div className="grid grid-cols-1 gap-4">
                        {recentGrades.map((g) => (
                            <GradeCard
                                key={`${g.code}-${g.year}-${g.semester}`}
                                grade={g}
                                darkMode={darkMode}
                                onSelect={onSelectCourse}
                                scrollingRef={scrollingRef}
                                isHome
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className={`rounded-3xl shadow-sm border p-6 min-h-[300px] transition-colors duration-300 ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'}`}>
                <h3 className={`text-lg font-black uppercase tracking-tight mb-8 ${darkMode ? 'text-gray-100' : 'text-gray-800'}`}>Average Per Semester</h3>
                <div className="h-64 w-full">
                    <Bar
                        data={barChartData as ChartData<'bar', number[], string>}
                        options={barOptions as ChartOptions<'bar'>}
                    />
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
    onOpenSettings: () => void;
    onSelectCourse: (code: string | null) => void;
    scrollingRef: React.MutableRefObject<boolean>;
    darkMode: boolean;
    onRefresh: () => void;
    onLogout: () => void;
    isLoading: boolean;
    isBackgroundLoading: boolean;
    scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}> = ({ allGrades, searchTerm, setSearchTerm, filters, onOpenFilters, onOpenSettings, onSelectCourse, scrollingRef, darkMode, onRefresh, onLogout, isLoading, isBackgroundLoading, scrollContainerRef }) => {
    const sectionRefs = React.useRef<Record<number, HTMLDivElement | null>>({});
    const [currentSection, setCurrentSection] = useState<number | null>(null);
    const tabsContainerRef = React.useRef<HTMLDivElement>(null);
    const autoScrollTargetRef = React.useRef<number | null>(null);
    const autoScrollReleaseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (currentSection !== null && tabsContainerRef.current) {
            const activeBtn = tabsContainerRef.current.querySelector('[data-active="true"]') as HTMLElement;
            if (activeBtn) {
                const container = tabsContainerRef.current;
                const scrollLeft = activeBtn.offsetLeft - (container.clientWidth / 2) + (activeBtn.clientWidth / 2);
                container.scrollTo({ left: scrollLeft, behavior: 'smooth' });
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

    const passedAveragesBySemester = useMemo(() => {
        const groups = new Map<number, { count: number; sum: number }>();
        allGrades.forEach((g: Grade) => {
            const sem = parseInt(g.semester, 10) || 0;
            if (!groups.has(sem)) groups.set(sem, { count: 0, sum: 0 });
            const val = parseFloat((g.grade || '').replace(',', '.'));
            if (!isNaN(val) && val >= 5) {
                const bucket = groups.get(sem);
                if (bucket) {
                    bucket.count += 1;
                    bucket.sum += val;
                }
            }
        });

        const output = new Map<number, number>();
        for (const [sem, bucket] of groups.entries()) {
            output.set(sem, bucket.count > 0 ? parseFloat((bucket.sum / bucket.count).toFixed(2)) : 0);
        }
        return output;
    }, [allGrades]);

    const semesterGroups = useMemo(() => {
        const groups = new Map<number, { grades: Grade[]; avg: number }>();
        filteredGrades.forEach((g: Grade) => {
            const sem = parseInt(g.semester) || 0;
            if (!groups.has(sem)) groups.set(sem, { grades: [], avg: 0 });
            groups.get(sem)?.grades.push(g);
        });

        groups.forEach((val) => {
            const sem = parseInt(val.grades[0]?.semester || '0', 10) || 0;
            val.avg = passedAveragesBySemester.get(sem) || 0;
        });

        const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
        return sortedKeys.map(key => ({
            semester: key,
            grades: groups.get(key)?.grades || [],
            average: groups.get(key)?.avg || 0
        }));
    }, [filteredGrades, passedAveragesBySemester]);

    useEffect(() => {
        const computeActiveSection = () => {
            if (!scrollContainerRef?.current) return null;
            const container = scrollContainerRef.current;
            const scrollPos = container.scrollTop + 224;
            const isAtBottom = container.clientHeight + container.scrollTop >= container.scrollHeight - 50;

            const orderedSections = Object.entries(sectionRefs.current)
                .filter(([, el]) => !!el)
                .map(([sem, el]) => ({ sem: Number(sem), top: (el as HTMLDivElement).offsetTop }))
                .sort((a, b) => a.top - b.top);

            if (isAtBottom && orderedSections.length > 0) {
                return orderedSections[orderedSections.length - 1].sem;
            }

            let bestMatch: number | null = null;
            for (const section of orderedSections) {
                if (section.top <= scrollPos) {
                    bestMatch = section.sem;
                } else {
                    break;
                }
            }

            if (bestMatch === null && orderedSections.length > 0) {
                bestMatch = orderedSections[0].sem;
            }

            return bestMatch;
        };

        const handleScroll = () => {
            if (autoScrollTargetRef.current !== null) {
                if (autoScrollReleaseTimerRef.current) clearTimeout(autoScrollReleaseTimerRef.current);
                autoScrollReleaseTimerRef.current = setTimeout(() => {
                    autoScrollTargetRef.current = null;
                    setCurrentSection(computeActiveSection());
                }, 140);
                return;
            }
            setCurrentSection(computeActiveSection());
        };

        const cancelAutoScrollLock = () => {
            if (autoScrollTargetRef.current === null) return;
            autoScrollTargetRef.current = null;
            if (autoScrollReleaseTimerRef.current) {
                clearTimeout(autoScrollReleaseTimerRef.current);
                autoScrollReleaseTimerRef.current = null;
            }
            setCurrentSection(computeActiveSection());
        };

        const container = scrollContainerRef?.current || window;
        container.addEventListener('scroll', handleScroll, { passive: true });
        if (scrollContainerRef?.current) {
            container.addEventListener('wheel', cancelAutoScrollLock, { passive: true });
            container.addEventListener('touchstart', cancelAutoScrollLock, { passive: true });
        } else {
            window.addEventListener('wheel', cancelAutoScrollLock, { passive: true });
            window.addEventListener('touchstart', cancelAutoScrollLock, { passive: true });
        }
        handleScroll();
        return () => {
            container.removeEventListener('scroll', handleScroll);
            if (scrollContainerRef?.current) {
                container.removeEventListener('wheel', cancelAutoScrollLock);
                container.removeEventListener('touchstart', cancelAutoScrollLock);
            } else {
                window.removeEventListener('wheel', cancelAutoScrollLock);
                window.removeEventListener('touchstart', cancelAutoScrollLock);
            }
            if (autoScrollReleaseTimerRef.current) clearTimeout(autoScrollReleaseTimerRef.current);
        };
    }, [scrollContainerRef]);

    const scrollToSemester = (sem: number) => {
        const el = sectionRefs.current[sem];
        if (el) {
            const offset = el.offsetTop - 220;
            autoScrollTargetRef.current = sem;
            if (autoScrollReleaseTimerRef.current) clearTimeout(autoScrollReleaseTimerRef.current);
            setCurrentSection(sem);
            const container = scrollContainerRef?.current || window;
            container.scrollTo({ top: offset, behavior: 'smooth' });
        }
    };

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="sticky top-0 z-40 -mx-4 px-4 py-3 bg-gray-50/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-200/40 dark:border-gray-700/40">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-2xl font-black uppercase tracking-tight">Grades</h2>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onRefresh}
                            className={`p-2 rounded-xl transition-all ${darkMode ? 'text-gray-400 hover:text-blue-400 hover:bg-gray-800' : 'text-gray-400 hover:text-blue-500 hover:bg-blue-50'} ${isLoading || isBackgroundLoading ? 'animate-spin text-blue-500' : ''}`}
                            title="Refresh Grades"
                            disabled={isLoading}
                        >
                            <RefreshCw className="w-5 h-5" />
                        </button>
                        <button
                            onClick={onLogout}
                            className={`p-2 rounded-xl transition-all ${darkMode ? 'text-gray-400 hover:text-red-400 hover:bg-gray-800' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'}`}
                            title="Logout"
                        >
                            <LogOut className="w-5 h-5" />
                        </button>
                        <div className={`w-px h-6 mx-1 ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}></div>
                        <button
                            onClick={onOpenFilters}
                            className={`p-2 rounded-xl transition-all ${Object.values(filters).some(Boolean) ? 'bg-indigo-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-400'}`}
                            title="Filters"
                        >
                            <Filter className="w-5 h-5" />
                        </button>
                        <button
                            onClick={onOpenSettings}
                            className={`p-2 rounded-xl transition-all ${darkMode ? 'bg-gray-800 text-gray-300 hover:text-indigo-300' : 'bg-gray-100 text-gray-500 hover:text-indigo-600'}`}
                            title="Settings"
                        >
                            <Settings className="w-5 h-5" />
                        </button>
                    </div>
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

                {semesterGroups.length > 0 && (
                    <div className="-mx-4 px-4 pb-2">
                        <div ref={tabsContainerRef} className="flex gap-2 overflow-x-auto px-2 pt-1 pb-5 scrollbar-hide no-scrollbar">
                            {semesterGroups.map(g => (
                                <button
                                    key={g.semester}
                                    data-active={currentSection === g.semester}
                                    onClick={() => scrollToSemester(g.semester)}
                                    className={`shrink-0 px-4 py-2 rounded-full text-xs font-black uppercase tracking-wider transition-all ${currentSection === g.semester ? 'bg-indigo-500 text-white ring-2 ring-indigo-300/60 dark:ring-indigo-400/40 shadow-[0_4px_10px_-3px_rgba(99,102,241,0.6)]' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                >
                                    Sem {g.semester === 0 ? 'Other' : g.semester}
                                </button>
                            ))}
                        </div>
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
                            {group.grades.map((g: Grade) => (
                                <GradeCard
                                    key={`${g.code}-${g.year}-${g.semester}`}
                                    grade={g}
                                    darkMode={darkMode}
                                    onSelect={onSelectCourse}
                                    scrollingRef={scrollingRef}
                                />
                            ))}
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
    const dragControls = useDragControls();
    const [isSheetDragging, setIsSheetDragging] = useState(false);
    const [isSheetClosing, setIsSheetClosing] = useState(false);
    const sheetRef = React.useRef<HTMLDivElement>(null);
    const sheetY = useMotionValue(typeof window !== 'undefined' ? window.innerHeight : 1000);
    const isClosingRef = React.useRef(false);
    const closeFallbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const closeSheet = React.useCallback(() => {
        if (isClosingRef.current) return;
        isClosingRef.current = true;
        setIsSheetClosing(true);
        setIsSheetDragging(false);

        const targetY = sheetRef.current?.offsetHeight || window.innerHeight;
        animate(sheetY, targetY, {
            type: 'tween',
            ease: 'easeOut',
            duration: 0.2,
            onComplete: () => {
                onClose();
            },
        });

        if (closeFallbackTimerRef.current) {
            clearTimeout(closeFallbackTimerRef.current);
        }
        closeFallbackTimerRef.current = setTimeout(() => {
            onClose();
        }, 260);
    }, [onClose, sheetY]);

    useEffect(() => {
        if (!isSheetDragging) return;
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        return () => {
            document.body.style.userSelect = prevUserSelect;
        };
    }, [isSheetDragging]);

    useEffect(() => {
        return () => {
            if (closeFallbackTimerRef.current) {
                clearTimeout(closeFallbackTimerRef.current);
            }
            document.body.style.userSelect = '';
        };
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        isClosingRef.current = false;
        setIsSheetClosing(false);
        setIsSheetDragging(false);

        if (closeFallbackTimerRef.current) {
            clearTimeout(closeFallbackTimerRef.current);
            closeFallbackTimerRef.current = null;
        }

        const startY = sheetRef.current?.offsetHeight || window.innerHeight;
        sheetY.set(startY);
        const raf = window.requestAnimationFrame(() => {
            animate(sheetY, 0, {
                type: 'spring',
                damping: 25,
                stiffness: 200,
            });
        });

        return () => window.cancelAnimationFrame(raf);
    }, [isOpen, sheetY]);

    return (
        <AnimatePresence onExitComplete={() => {
            isClosingRef.current = false;
            setIsSheetClosing(false);
            setIsSheetDragging(false);
            if (closeFallbackTimerRef.current) {
                clearTimeout(closeFallbackTimerRef.current);
                closeFallbackTimerRef.current = null;
            }
        }}>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={closeSheet}
                        className={`fixed inset-0 bg-black/55 z-[60] ${isSheetClosing ? 'pointer-events-none' : ''}`}
                    />
                    <motion.div
                        ref={sheetRef}
                        style={{ y: sheetY }}
                        initial={{ y: typeof window !== 'undefined' ? window.innerHeight : 1000 }}
                        exit={{ opacity: 1 }}
                        drag="y"
                        dragControls={dragControls}
                        dragListener={false}
                        dragDirectionLock
                        dragConstraints={{ top: 0, bottom: 520 }}
                        dragElastic={0}
                        dragMomentum={false}
                        onDragStart={() => setIsSheetDragging(true)}
                        onDragEnd={(_event, info) => {
                            setIsSheetDragging(false);
                            if (isClosingRef.current) return;

                            const sheetHeight = sheetRef.current?.offsetHeight || 0;
                            const closeThreshold = sheetHeight * 0.1;
                            if (info.offset.y > closeThreshold) {
                                closeSheet();
                                return;
                            }

                            animate(sheetY, 0, {
                                type: 'spring',
                                stiffness: 420,
                                damping: 36,
                                mass: 0.75,
                            });
                        }}
                        className={`fixed bottom-0 left-0 right-0 z-[70] p-8 rounded-t-[3rem] shadow-2xl ${darkMode ? 'bg-gray-800' : 'bg-white'} ${isSheetClosing ? 'pointer-events-none' : ''}`}
                    >
                        <div
                            onPointerDown={(e) => dragControls.start(e)}
                            className="mx-[-2rem] -mt-4 mb-4 w-[calc(100%+4rem)] h-14 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none"
                        >
                            <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full opacity-20" />
                        </div>
                        <h3 className="text-xl font-black uppercase tracking-tight mb-8">Filter Grades</h3>

                        <div className="space-y-4 mb-10">
                            {[
                                { id: 'passed', label: 'Passed', color: 'text-green-500' },
                                { id: 'failed', label: 'Failed', color: 'text-red-500' },
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
                                onClick={() => {
                                    onRestore();
                                    closeSheet();
                                }}
                                className="flex-1 py-4 font-black uppercase tracking-widest text-gray-400 bg-gray-100 dark:bg-gray-700 rounded-2xl hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                            >
                                Reset
                            </button>
                            <button
                                onClick={() => {
                                    onApply();
                                    closeSheet();
                                }}
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
    autoSolveAvailable,
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
    const homeScrollRef = React.useRef<HTMLDivElement>(null);
    const gradesScrollRef = React.useRef<HTMLDivElement>(null);
    const refreshRef = React.useRef(onRefresh);
    refreshRef.current = onRefresh;
    const loadingRef = React.useRef(isLoading || isBackgroundLoading);
    loadingRef.current = isLoading || isBackgroundLoading;
    const activeTabRef = React.useRef(activeTab);
    activeTabRef.current = activeTab;
    const filterMenuOpenRef = React.useRef(isFilterMenuOpen);
    filterMenuOpenRef.current = isFilterMenuOpen;
    const selectedCourseRef = React.useRef(selectedCourseCode);
    selectedCourseRef.current = selectedCourseCode;
    const ptrInstanceRef = React.useRef<PullToRefreshInstance | null>(null);

    useEffect(() => {
        const onScroll = () => {
            scrollingRef.current = true;
            if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
            scrollTimerRef.current = setTimeout(() => {
                scrollingRef.current = false;
            }, 100);
        };
        const h = homeScrollRef.current;
        const g = gradesScrollRef.current;
        h?.addEventListener('scroll', onScroll, { passive: true });
        g?.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            h?.removeEventListener('scroll', onScroll);
            g?.removeEventListener('scroll', onScroll);
        };
    }, []);

    useEffect(() => {
        if (ptrInstanceRef.current) return;

        PullToRefresh.setPassiveMode(false);
        PullToRefresh.setPointerEventsMode(false);

        const instance = PullToRefresh.init({
            classPrefix: 'ug-ptr--',
            mainElement: '#dashboard-scroll-shell',
            triggerElement: '#dashboard-scroll-shell',
            distIgnore: 10,
            distThreshold: 72,
            distMax: 96,
            distReload: 56,
            refreshTimeout: 320,
            instructionsPullToRefresh: 'Pull down to refresh',
            instructionsReleaseToRefresh: 'Release to refresh',
            instructionsRefreshing: 'Refreshing...',
            shouldPullToRefresh: () => {
                if (loadingRef.current) return false;
                if (filterMenuOpenRef.current) return false;
                if (selectedCourseRef.current) return false;

                const activeScroller = activeTabRef.current === 'home'
                    ? homeScrollRef.current
                    : gradesScrollRef.current;

                if (!activeScroller) return false;
                const maxScrollableY = activeScroller.scrollHeight - activeScroller.clientHeight;
                if (maxScrollableY < 48) return false;
                return activeScroller.scrollTop <= 1;
            },
            onRefresh: () => Promise.resolve(refreshRef.current()),
        });

        ptrInstanceRef.current = instance;

        return () => {
            PullToRefresh.destroyAll();
            ptrInstanceRef.current = null;
        };
    }, []);

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
            // Draw order controls visual stacking with rounded overlaps:
            // No grade (back) -> Passed (middle) -> Failed (front)
            labels: ['No grade', 'Passed', 'Failed'],
            datasets: [
                {
                    data: [noGrade, passed, failed],
                    // Invisible base arcs for hit-testing only; visible arcs are drawn by RoundedDonutPlugin.
                    backgroundColor: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
                    segmentColors: ['#6B7280', '#10B981', '#EF4444'],
                    borderColor: 'rgba(0,0,0,0)',
                    borderWidth: 0,
                    borderRadius: 0,
                    spacing: 0,
                    hoverOffset: 0,
                    hoverBorderWidth: 0,
                },
            ],
        };
    }, [allGrades, darkMode]);

    const barChartData = useMemo(() => {
        const groups = new Map<number, { count: number; sum: number }>();
        allGrades.forEach((g: Grade) => {
            const key = g.semester.replace(/[^0-9]/g, '');
            const semInt = parseInt(key, 10);
            const mapKey = isNaN(semInt) ? 0 : semInt;
            if (!groups.has(mapKey)) groups.set(mapKey, { count: 0, sum: 0 });

            const val = parseFloat(g.grade);
            if (!isNaN(val) && val >= 5) {
                const d = groups.get(mapKey);
                if (d) {
                    d.count++;
                    d.sum += val;
                }
            }
        });

        const dataPoints = Array.from(groups.entries()).map(([name, val]) => ({
            sem: name,
            avg: val.count > 0 ? parseFloat((val.sum / val.count).toFixed(2)) : 0,
        })).sort((a, b) => a.sem - b.sem);
        const rawAverages = dataPoints.map(d => d.avg);

        return {
            labels: dataPoints.map(d => d.sem === 0 ? 'Other' : `Sem ${d.sem}`),
            datasets: [
                {
                    label: 'Background',
                    data: dataPoints.map(() => 10),
                    backgroundColor: darkMode ? '#111827' : '#e5e7eb',
                    hoverBackgroundColor: darkMode ? '#111827' : '#e5e7eb',
                    order: 2,
                    base: 4,
                    grouped: false,
                    borderRadius: 999,
                    borderSkipped: false,
                    clip: { bottom: -12, top: 0, left: 0, right: 0 },
                    barThickness: 20,
                },
                {
                    label: 'Average Grade',
                    data: rawAverages.map(v => (v > 0 ? Math.max(v, 4.1) : 4.1)),
                    rawAverages,
                    backgroundColor: '#6366f1',
                    hoverBackgroundColor: '#6366f1',
                    order: 1,
                    base: 4,
                    grouped: false,
                    borderRadius: 999,
                    borderSkipped: false,
                    clip: { bottom: -12, top: 0, left: 0, right: 0 },
                    barThickness: 20,
                },
            ],
        };
    }, [allGrades, darkMode]);

    const pieOptions = {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '80%',
        elements: {
            arc: {
                borderRadius: 999,
            }
        },
        onClick: (_event: unknown, elements: Array<{ index: number }>) => {
            if (!elements.length) return;
            const idx = elements[0].index;
            const nextFilters = {
                noGrade: idx === 0,
                passed: idx === 1,
                failed: idx === 2,
            };
            setFilters(nextFilters);
            setActiveTab('grades');
        },
        onHover: (event: unknown, elements: Array<unknown>) => {
            const target = (event as { native?: { target?: HTMLElement } })?.native?.target;
            if (target) {
                target.style.cursor = elements.length ? 'pointer' : 'default';
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: false,
            },
            datalabels: { display: false }
        }
    };

    const barOptions = {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
            padding: { top: 20, bottom: 20 }
        },
        onHover: (event: unknown, elements: Array<unknown>) => {
            const target = (event as { native?: { target?: HTMLElement } })?.native?.target;
            if (target) {
                target.style.cursor = elements.length ? 'pointer' : 'default';
            }
        },
        scales: {
            y: {
                min: 3.45,
                max: 10,
                grace: 0.4,
                display: true,
                grid: {
                    display: false,
                    drawBorder: false
                },
                border: { display: false },
                ticks: {
                    stepSize: 1,
                    color: darkMode ? '#9ca3af' : '#6b7280',
                    font: { weight: 'bold' as const },
                    callback: (value: number | string) => {
                        const num = typeof value === 'number' ? value : Number(value);
                        return num >= 4 ? `${num}` : '';
                    }
                },
                stacked: false
            },
            x: {
                grid: { display: false },
                border: { display: false },
                ticks: {
                    color: darkMode ? '#9ca3af' : '#6b7280',
                    font: { weight: 'bold' as const }
                },
                stacked: false
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: true,
                mode: 'index' as const,
                intersect: false,
                filter: (item: { datasetIndex: number }) => item.datasetIndex === 1,
                displayColors: false,
                backgroundColor: darkMode ? '#374151' : '#fff',
                titleColor: darkMode ? '#fff' : '#111827',
                bodyColor: darkMode ? '#d1d5db' : '#4b5563',
                borderColor: darkMode ? '#4b5563' : '#e5e7eb',
                borderWidth: 1,
                padding: { top: 10, bottom: 10, left: 12, right: 12 },
                cornerRadius: 8,
                bodyAlign: 'center' as const,
                titleAlign: 'center' as const,
                titleMarginBottom: 0,
                callbacks: {
                    title: () => '',
                    label: (context: { dataIndex: number; label: string; dataset: { rawAverages?: number[] } }) => {
                        const raw = context.dataset?.rawAverages?.[context.dataIndex];
                        const label = context.label?.replace(/^Sem\s+/i, 'Semester ') || 'Semester';
                        const average = typeof raw === 'number' ? raw : 0;
                        return `${label} | Average ${average.toFixed(2)}`;
                    },
                }
            },
            datalabels: {
                display: false,
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
            <div
                id="dashboard-scroll-shell"
                className={`h-[100dvh] w-full relative overflow-hidden overscroll-y-none transition-colors duration-300 ${darkMode ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'} ${selectedCourseData ? 'pointer-events-none select-none' : ''}`}
            >
                {/* Home Tab Container */}
                <div
                    id="dashboard-home-scroll"
                    ref={homeScrollRef}
                    className={`absolute inset-0 overflow-y-auto overscroll-y-contain [touch-action:pan-y] [-webkit-overflow-scrolling:touch] pt-0 pb-28 transition-opacity duration-300 ${activeTab === 'home' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}
                >
                    <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-100'} shadow-sm sticky top-0 z-40 border-b transition-colors duration-300`}>
                        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
                            <div>
                                <h1 className={`text-2xl font-bold leading-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                                    Hello 👋
                                </h1>
                                <p className="text-lg font-extrabold text-indigo-500">{studentInfo?.name || 'Student'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setSettingsOpen(true)}
                                    className={`p-3 rounded-full transition-all ${darkMode ? 'text-gray-400 hover:text-indigo-300 hover:bg-gray-700' : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50'}`}
                                    title="Settings"
                                >
                                    <Settings className="w-6 h-6" />
                                </button>
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

                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 space-y-6">
                        <HomeTab
                            studentInfo={studentInfo}
                            allGrades={allGrades}
                            fullHistory={fullHistory}
                            metricsData={metricsData}
                            pieOptions={pieOptions}
                            barChartData={barChartData}
                            barOptions={barOptions}
                            darkMode={darkMode}
                            onMetricFilterSelect={(key) => {
                                setFilters({
                                    passed: key === 'passed',
                                    failed: key === 'failed',
                                    noGrade: key === 'noGrade',
                                });
                                setActiveTab('grades');
                            }}
                            onViewAll={() => setActiveTab('grades')}
                            onSelectCourse={onSelectCourse}
                            scrollingRef={scrollingRef}
                        />
                    </div>
                </div>

                {/* Grades Tab Container */}
                <div
                    id="dashboard-grades-scroll"
                    ref={gradesScrollRef}
                    className={`absolute inset-0 overflow-y-auto overscroll-y-contain [touch-action:pan-y] [-webkit-overflow-scrolling:touch] pt-0 pb-28 transition-opacity duration-300 ${activeTab === 'grades' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}
                >
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
                        <GradesTab
                            allGrades={allGrades}
                            searchTerm={searchTerm}
                            setSearchTerm={setSearchTerm}
                            filters={filters}
                            onOpenFilters={() => {
                                setFiltersTemp(filters);
                                setIsFilterMenuOpen(true);
                            }}
                            onOpenSettings={() => setSettingsOpen(true)}
                            onSelectCourse={onSelectCourse}
                            scrollingRef={scrollingRef}
                            darkMode={darkMode}
                            onRefresh={onRefresh}
                            onLogout={onLogout}
                            isLoading={isLoading}
                            isBackgroundLoading={isBackgroundLoading}
                            scrollContainerRef={gradesScrollRef}
                        />
                    </div>
                </div>
            </div>

            <div
                className={`fixed inset-x-0 bottom-0 z-40 border-t flex items-center justify-around px-6 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] transition-colors duration-300 ${darkMode ? 'bg-gray-800/95 border-gray-700' : 'bg-white/95 border-gray-100'} backdrop-blur-md`}
            >
                <button
                    onClick={() => setActiveTab('home')}
                    className={`flex min-w-[5.5rem] flex-col items-center gap-1 px-5 py-3 rounded-xl transition-all ${activeTab === 'home' ? 'text-indigo-500' : 'text-gray-400'}`}
                >
                    <Home className={`w-6 h-6 ${activeTab === 'home' ? 'fill-indigo-500/10' : ''}`} />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Home</span>
                </button>
                <button
                    onClick={() => setActiveTab('grades')}
                    className={`flex min-w-[5.5rem] flex-col items-center gap-1 px-5 py-3 rounded-xl transition-all ${activeTab === 'grades' ? 'text-indigo-500' : 'text-gray-400'}`}
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
                }}
                onRestore={() => {
                    const reset = { passed: false, failed: false, noGrade: false };
                    setFilters(reset);
                    setFiltersTemp(reset);
                }}
                darkMode={darkMode}
            />

            <AnimatePresence>
                {selectedCourseData && (
                    <CourseDetailView
                        key={`detail-${selectedCourseCode}`}
                        data={selectedCourseData}
                        darkMode={darkMode}
                        onSelectCourse={onSelectCourse}
                        detailRef={detailRef}
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
                        onToggleTheme={toggleTheme}
                        mongoEnabled={mongoEnabled}
                        pushEnabled={pushEnabled}
                        autoSolveAvailable={autoSolveAvailable}
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
    const textSize = isSmall ? 'text-4xl' : isMedium ? 'text-6xl' : 'text-7xl';
    const gradeLabelSize = isSmall
        ? 'text-[11px] mt-2 tracking-[0.24em] mr-[-0.24em]'
        : isMedium
            ? 'text-[14px] mt-2.5 tracking-[0.26em] mr-[-0.26em]'
            : 'text-[15px] mt-3 tracking-[0.3em] mr-[-0.3em]';
    const nsRingRadius = radius - strokeW - 4; // Inside the gauge
    const bgInset = isSmall ? 8 : isMedium ? 10 : 12;

    const topY = center - radius;
    const bottomY = center + radius;

    return (
        <div className={`relative ${containerClass} flex items-center justify-center`}>
            <div
                className="absolute rounded-full pointer-events-none"
                style={{
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: `calc(100% - ${bgInset}px)`,
                    height: `calc(100% - ${bgInset}px)`,
                    backgroundColor: darkMode ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)',
                }}
            />
            <svg className="w-full h-full drop-shadow-md" viewBox={viewBox}>
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={darkMode ? "#1f2937" : "#ffffff"}
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
                {hasVisibleGrade(grade) ? (
                    <span className={`${textSize} font-black ${statusColor} tracking-tighter`}>
                        {grade}
                    </span>
                ) : (
                    <NoGradePill darkMode={darkMode} gauge />
                )}
                {isNumber && (
                    <span className={`${gradeLabelSize} font-black uppercase ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
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
    stripAccents: (s: string | undefined) => string;
    animateOut: boolean;
}> = ({ data, darkMode, onSelectCourse, detailRef, stripAccents, animateOut }) => {
    const { latest, history } = data;
    const historyLabels = history.map(h => h.year);
    const historyScores = history.map(h => {
        const v = parseFloat((h.grade || '').replace(',', '.'));
        return Number.isNaN(v) ? null : v;
    });

    const lineData = {
        labels: historyLabels,
        datasets: [{
            data: historyScores,
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
            borderWidth: 3,
            showLine: true,
            pointRadius: 6,
            pointBorderWidth: 2,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: true,
            spanGaps: true
        }]
    };

    const lineOptions: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        onHover: (event: unknown, elements: Array<unknown>) => {
            const target = (event as { native?: { target?: HTMLElement } })?.native?.target;
            if (target) {
                target.style.cursor = elements.length ? 'pointer' : 'default';
            }
        },
        scales: {
            y: {
                min: -0.5,
                max: 10.5,
                afterBuildTicks: (scale) => {
                    scale.ticks = Array.from({ length: 11 }, (_, i) => ({ value: i }));
                },
                grid: {
                    color: darkMode ? 'rgba(156,163,175,0.15)' : 'rgba(107,114,128,0.12)',
                },
                border: { display: false },
                ticks: {
                    color: darkMode ? '#9ca3af' : '#6b7280',
                    font: { weight: 'bold' },
                },
            },
            x: {
                offset: history.length === 1,
                grid: { display: false },
                border: { display: false },
                ticks: {
                    color: darkMode ? '#9ca3af' : '#6b7280',
                    font: { weight: 'bold' },
                },
            },
        },
        plugins: {
            legend: { display: false },
            datalabels: { display: false },
            tooltip: {
                enabled: true,
                mode: 'nearest',
                intersect: false,
                displayColors: false,
                backgroundColor: darkMode ? '#374151' : '#fff',
                titleColor: darkMode ? '#fff' : '#111827',
                bodyColor: darkMode ? '#d1d5db' : '#4b5563',
                borderColor: darkMode ? '#4b5563' : '#e5e7eb',
                borderWidth: 1,
                padding: { top: 10, bottom: 10, left: 12, right: 12 },
                cornerRadius: 8,
                callbacks: {
                    title: (items) => {
                        const idx = items[0]?.dataIndex ?? -1;
                        if (idx < 0) return '';
                        const gradeValue = history[idx]?.grade;
                        const gradeText = hasVisibleGrade(gradeValue) ? gradeValue : 'No grade';
                        return `${historyLabels[idx]} | ${gradeText}`;
                    },
                    label: () => '',
                },
            },
        },
    };

    return (
        <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={animateOut ? { x: '100%', transition: { type: 'tween', ease: 'easeIn', duration: 0.3 } } : undefined}
            transition={{ type: 'tween', ease: 'easeOut', duration: 0.35 }}
            className="fixed inset-0 z-50 overflow-hidden"
        >
            <div ref={detailRef} className={`min-h-screen h-screen overflow-y-auto transition-colors duration-300 ${darkMode ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
                <header className="sticky top-0 z-50 bg-white/80 dark:bg-gray-800/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-700 h-24 flex items-center px-4">
                    <button
                        onClick={() => onSelectCourse(null)}
                        className="p-3 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-6 h-6" />
                    </button>
                    <div className="flex-1 px-4 overflow-hidden text-center">
                        <span className={`text-xs font-black uppercase tracking-widest block ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                            {latest.code}{latest.category ? ` | ${latest.category}` : ''}
                        </span>
                        <h2 className="text-base md:text-xl font-black text-center px-4 uppercase tracking-tight leading-tight line-clamp-2 mt-1">
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
                                    <span className="text-[10px] block uppercase font-black opacity-50 mb-1">ECTS</span>
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
                        <h3 className="text-sm font-black uppercase tracking-widest mb-4 opacity-50">Grade History</h3>
                        <div className="h-[250px]">
                            <Line
                                data={lineData}
                                options={lineOptions}
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
                                    <div key={`${h.code}-${i}`} className={`flex justify-between items-center p-4 rounded-xl ${darkMode ? 'bg-gray-900/50' : 'bg-gray-100'}`}>
                                        <div className="flex-1 flex flex-col">
                                            <span className="text-sm font-bold">{h.year}</span>
                                            <span className="text-xs text-gray-500">
                                                {(h.acadSession || '').replace(/Εξάμηνο/gi, '').trim()} {h.year} {h.apprStatus ? `| ${h.apprStatus}` : ''}
                                            </span>
                                        </div>
                                        <div className="shrink-0 w-20 flex flex-col items-center justify-center">
                                            <span className={`text-lg font-black ${c}`}>
                                                {hasVisibleGrade(h.grade) ? h.grade : <NoGradePill darkMode={darkMode} compact />}
                                            </span>
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
