export interface StudentInfo {
    name: string;
    average: string;
    totalCredits: string;
    totalGreekCredits: string;
}

export interface Grade {
    semester: string;
    code: string;
    title: string;
    grade: string;
    year: string;
    session?: string;
    ects: string;
    status: string;
    category?: string;
    acadSession?: string;
    apprStatus?: string;
    bkgStatus?: string;
    gravity?: string;
    greekCredits?: string;
    evalMethod?: string;
    isNew?: boolean;
    dateAdded?: string | null;
}
