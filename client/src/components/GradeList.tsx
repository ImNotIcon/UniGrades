import React from 'react';
import { BookOpen, CheckCircle, Clock } from 'lucide-react';
import { motion } from 'framer-motion';

interface Grade {
    semester: string;
    category: string;
    code: string;
    title: string;
    grade: string;
    year: string;
    session: string;
    status: string;
    enrolled: string;
}

interface GradeListProps {
    grades: Grade[];
}

export const GradeList: React.FC<GradeListProps> = ({ grades }) => {
    // Group by semester
    const grouped = grades.reduce((acc, grade) => {
        const sem = grade.semester;
        if (!acc[sem]) acc[sem] = [];
        acc[sem].push(grade);
        return acc;
    }, {} as Record<string, Grade[]>);

    const semesters = Object.keys(grouped).sort((a, b) => Number(b) - Number(a));

    return (
        <div className="min-h-screen bg-gray-50 pb-20">
            <header className="bg-white/80 backdrop-blur-md sticky top-0 z-30 border-b border-gray-200/50 px-4 py-4 shadow-sm">
                <div className="max-w-3xl mx-auto flex items-center justify-between">
                    <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600 flex items-center gap-2">
                        <BookOpen className="text-indigo-600 w-6 h-6" />
                        Analytics
                    </h1>
                    <div className="flex gap-2">
                        <span className="text-xs font-bold font-mono bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-full ring-1 ring-indigo-100">
                            {grades.length} Courses
                        </span>
                        <span className="text-xs font-bold font-mono bg-green-50 text-green-700 px-3 py-1.5 rounded-full ring-1 ring-green-100">
                            {grades.filter(g => Number(g.grade?.replace(',', '.')) >= 5).length} Passed
                        </span>
                    </div>
                </div>
            </header>

            <main className="max-w-3xl mx-auto p-4 space-y-8 mt-2">
                {semesters.map((sem) => (
                    <motion.div
                        key={sem}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                        className="space-y-4"
                    >
                        <div className="flex items-center gap-4 px-2">
                            <h2 className="text-lg font-bold text-gray-800 bg-white px-4 py-1.5 rounded-full shadow-sm ring-1 ring-gray-100">
                                Semester {sem}
                            </h2>
                            <div className="h-px bg-gray-200 flex-1"></div>
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                {grouped[sem][0].year}
                            </span>
                        </div>

                        <div className="grid gap-3">
                            {grouped[sem].map((grade, idx) => (
                                <div
                                    key={idx}
                                    className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:shadow-md hover:border-indigo-100 transition-all duration-200 group relative overflow-hidden"
                                >
                                    <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>

                                    <div className="flex justify-between items-start gap-4 z-10 relative">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                <span className="text-[10px] font-black tracking-widest text-gray-400 bg-gray-100 px-2 py-1 rounded uppercase">
                                                    {grade.code}
                                                </span>
                                                {grade.status === 'Εγγεγραμμένος' && (
                                                    <span className="text-[10px] uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full flex items-center gap-1 font-bold">
                                                        <CheckCircle size={10} strokeWidth={3} /> Enrolled
                                                    </span>
                                                )}
                                                {grade.status === 'Προσωρινό' && (
                                                    <span className="text-[10px] uppercase tracking-wider text-amber-600 bg-amber-50 px-2 py-1 rounded-full flex items-center gap-1 font-bold">
                                                        <Clock size={10} strokeWidth={3} /> Pending
                                                    </span>
                                                )}
                                            </div>
                                            <h3 className="text-base font-bold text-gray-800 leading-snug group-hover:text-indigo-700 transition-colors">
                                                {grade.title}
                                            </h3>
                                            <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
                                                <span>{grade.category}</span>
                                                <span>•</span>
                                                <span>{grade.session}</span>
                                            </div>
                                        </div>

                                        <div className="flex flex-col items-end">
                                            {grade.grade && grade.grade !== 'NS' ? (
                                                <div className={`flex flex-col items-end ${Number(grade.grade.replace(',', '.')) >= 5 ? 'text-indigo-600' : 'text-rose-500'}`}>
                                                    <span className="text-2xl font-black tracking-tighter leading-none">
                                                        {grade.grade}
                                                    </span>
                                                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-60">Grade</span>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col items-end text-gray-300">
                                                    <span className="text-2xl font-black tracking-tighter leading-none">--</span>
                                                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-60">N/A</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </motion.div>
                ))}
            </main>
        </div>
    );
};
