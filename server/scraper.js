
const scrapeFrame = async (frame) => {
    return frame.evaluate(() => {
        const grades = [];
        // Extract grades only if this frame looks like a grades table
        // Find any element containing 'Semester' or 'Εξάμηνο' or 'Μάθημα' or 'Βαθμός'
        const allElements = Array.from(document.querySelectorAll('span, div, th, td, label'));
        let semesterHeader = allElements.find(el => {
            const t = (el.innerText || '').trim().toLowerCase();
            return t.includes('semester') || t.includes('εξάμηνο') || t.includes('εξ.') || t.includes('εξαμηνο') || t.includes('εξάμ');
        });

        if (!semesterHeader) {
            semesterHeader = allElements.find(el => {
                const t = (el.innerText || '').trim().toLowerCase();
                return t.includes('course') || t.includes('μάθημα') || t.includes('grade') || t.includes('βαθμ') || t.includes('αποτέλεσμα');
            });
        }

        if (!semesterHeader) {
            // Try to find ANY urST table
            const grid = document.querySelector('.urST, table[id*="WD"], table[ct="ST"]');
            if (grid) {
                // Use the first row as a hint
                semesterHeader = grid.querySelector('th, td, .urSTCell');
            }
        }

        if (!semesterHeader) return [];

        // Find the parent table or grid container
        let container = semesterHeader.parentElement;
        while (container && container !== document.body) {
            const tag = container.tagName;
            const ct = container.getAttribute('ct');
            // Look for SAP specific grid/table markers
            if (tag === 'TABLE' || ct === 'GL' || ct === 'ST' || ct === 'TABLE' || container.classList.contains('urST') || container.classList.contains('lsControl--fullwidth')) {
                // Check if it's a real table with rows
                if (container.querySelectorAll('tr, .urSTRow').length > 1) break;
            }
            container = container.parentElement;
        }

        if (!container || container === document.body) return [];

        let headerMap = {
            semester: -1, code: -1, title: -1, grade: -1, year: -1, ects: -1, status: -1,
            category: -1, acadSession: -1, apprStatus: -1, bkgStatus: -1, gravity: -1
        };

        /* SCORE-BASED HEADER ROW DETECTION */
        const allRows = Array.from(document.querySelectorAll('tr'));
        let candidates = [];

        for (const row of allRows) {
            const text = (row.innerText || '').toLowerCase();
            let score = 0;
            if (text.includes('semester')) score++;
            if (text.includes('code') || text.includes('κωδικός')) score++;
            if (text.includes('title') || text.includes('τίτλος')) score++;
            if (text.includes('grade symbol')) score += 2; // Strong indicator
            if (text.includes('academic year')) score++;

            if (score >= 2) {
                candidates.push({ row, score, len: text.length });
            }
        }

        candidates.sort((a, b) => b.score - a.score || a.len - b.len);
        if (candidates.length === 0) return { grades: [], headers: [] };

        let headerRow = candidates[0].row;

        /* COLUMN MAPPING */
        const headerCells = headerRow.cells ? Array.from(headerRow.cells) : Array.from(headerRow.querySelectorAll('th, td'));
        const rawHeaders = headerCells.map(c => (c.innerText || '').trim());

        headerCells.forEach((cell, index) => {
            const text = (cell.innerText || '').trim();
            const lower = text.toLowerCase();

            if (text === 'Module Semester') headerMap.semester = index;
            if (text === 'Module Categ.') headerMap.category = index;
            if (text === 'Κωδικός') headerMap.code = index;
            if (text === 'Τίτλος') headerMap.title = index;
            if (text === 'Grade Symbol') headerMap.grade = index;
            if (text === 'Academic year') headerMap.year = index;
            if (text === 'Weighting') headerMap.gravity = index;
            if (text === 'Attm.Credits') headerMap.ects = index;
            if (text === 'Bkg Status') headerMap.bkgStatus = index;
            if (text === 'Acad. Session') headerMap.acadSession = index;
            if (text === 'Appr.Status') headerMap.apprStatus = index;

            if (headerMap.status === -1 && (lower.includes('status') || lower.includes('κατάσταση'))) headerMap.status = index;
        });

        /* DATA ROW EXTRACTION */
        container = headerRow.parentElement.tagName === 'THEAD' ? headerRow.parentElement.parentElement : headerRow.parentElement;

        let dataRows = [];
        const tbody = container.querySelector && (container.querySelector('tbody[id$="contentTBody"]') || container.querySelector('tbody[id*="content"]'));
        dataRows = tbody ? Array.from(tbody.rows) : (container.rows ? Array.from(container.rows) : Array.from(container.querySelectorAll('tr')));

        for (const row of dataRows) {
            const cells = row.cells ? Array.from(row.cells) : Array.from(row.querySelectorAll('td, th'));
            if (cells.length < 3) continue;

            const getVal = (idx) => idx !== -1 && cells[idx] ? (cells[idx].innerText || '').trim() : '';

            const code = getVal(headerMap.code);
            const title = getVal(headerMap.title);
            if (!code && !title) continue;

            if ((code.toLowerCase().includes('code') || code.toLowerCase().includes('κωδ')) &&
                (title.toLowerCase().includes('title') || title.toLowerCase().includes('τίτλος'))) continue;

            const bkgStatus = getVal(headerMap.bkgStatus);

            grades.push({
                semester: getVal(headerMap.semester),
                code: code,
                title: title,
                grade: (getVal(headerMap.grade) || '').replace(',', '.'),
                year: getVal(headerMap.year),
                session: getVal(headerMap.acadSession),
                ects: (getVal(headerMap.ects) || '').replace(',', '.'),
                status: bkgStatus || getVal(headerMap.status) || 'Enrolled',
                category: getVal(headerMap.category),
                acadSession: getVal(headerMap.acadSession),
                apprStatus: getVal(headerMap.apprStatus),
                bkgStatus: bkgStatus,
                gravity: (getVal(headerMap.gravity) || '').replace(',', '.')
            });
        }
        return { grades, headers: rawHeaders };
    });
};

const scrapeStudentInfo = async (page) => {
    return page.evaluate(() => {
        const normalizeText = (value) => (value || '')
            .toString()
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();

        const parseNumericGrade = (value) => {
            const compact = (value || '').toString().trim().replace(/\s+/g, '').replace(',', '.');
            if (!/^\d{1,2}(\.\d{1,3})?$/.test(compact)) return '';
            const n = Number.parseFloat(compact);
            if (!Number.isFinite(n) || n < 0 || n > 10) return '';
            return compact;
        };

        let name = '';
        const labels = Array.from(document.querySelectorAll('label, span.lsLabel__text'));
        const nameLabel = labels.find(l => (l.innerText || '').includes('Ονοματεπώνυμο') || (l.innerText || '').includes('Name'));

        if (nameLabel) {
            // Traverse up to row or container to find value
            let parent = nameLabel.parentElement;
            while (parent && parent.tagName !== 'TR' && parent.tagName !== 'DIV') {
                parent = parent.parentElement;
            }
            if (parent) {
                // Try to find the value in the same row/container
                const inputs = parent.querySelectorAll('span.lsTextView--design-standard, input, div.lsTextView');
                for (let inp of inputs) {
                    const txt = (inp.innerText || inp.value || '').trim();
                    if (txt && !txt.includes('Ονοματεπώνυμο')) {
                        name = txt;
                        break;
                    }
                }
            }
        }

        // Clean name (split by ';' as requested: "SURNAME; NAME")
        if (name) {
            name = name.split(';')[0].replace(/,/g, '').trim();
        }

        // Average Grade (KPI table: "Δείκτες Απόδοσης")
        let average = '';
        const tables = Array.from(document.querySelectorAll('table'));
        const kpiTables = tables.filter((table) => {
            const text = normalizeText(table.innerText);
            return text.includes('δείκτες απόδοσης') || text.includes('δεικτες αποδοσης') || text.includes('performance indicators');
        });

        for (const table of kpiTables) {
            const rows = Array.from(table.querySelectorAll('tbody[id$="contentTBody"] tr, tbody tr, tr'));
            for (const row of rows) {
                const cells = Array.from(row.querySelectorAll('td, th'));
                if (cells.length < 3) continue;

                const metricLabel = normalizeText(cells[1] && cells[1].innerText);
                if (!metricLabel) continue;
                if ((!metricLabel.includes('βαθμ') && !metricLabel.includes('grade')) || metricLabel.includes('ects')) continue;

                const candidate = parseNumericGrade(cells[2] && cells[2].innerText);
                if (candidate) {
                    average = candidate;
                    break;
                }
            }
            if (average) break;
        }

        // Fallback if KPI parsing above misses due markup variations.
        if (!average) {
            const rows = Array.from(document.querySelectorAll('tr')).slice(0, 400);
            for (const row of rows) {
                const rowText = normalizeText(row.innerText);
                if ((!rowText.includes('βαθμ') && !rowText.includes('grade')) || rowText.includes('ects')) continue;

                const cells = Array.from(row.querySelectorAll('td, th'));
                if (cells.length >= 3) {
                    const fixedColCandidate = parseNumericGrade(cells[2] && cells[2].innerText);
                    if (fixedColCandidate) {
                        average = fixedColCandidate;
                        break;
                    }
                }

                for (const cell of cells) {
                    const looseCandidate = parseNumericGrade(cell && cell.innerText);
                    if (looseCandidate) {
                        average = looseCandidate;
                        break;
                    }
                }
                if (average) break;
            }
        }

        // Statistics - Robust Text Search
        let totalCredits = '';
        let totalGreekCredits = '';

        const findValueByText = (searchTexts, isExact = false) => {
            // 1. Try finding a label with matching text and 'for'/'f' attribute
            const allLabels = Array.from(document.querySelectorAll('label'));
            for (const label of allLabels) {
                const txt = (label.innerText || '').trim();
                const matched = isExact
                    ? searchTexts.some(st => txt === st)
                    : searchTexts.some(st => txt.toLowerCase().includes(st.toLowerCase()));

                if (matched) {
                    const targetId = label.getAttribute('for') || label.getAttribute('f');
                    if (targetId) {
                        const inp = document.getElementById(targetId);
                        if (inp) return inp.value || inp.innerText;
                    }
                }
            }

            // 2. Lightweight row/cell scan fallback (avoids full DOM '*' scan)
            const rows = Array.from(document.querySelectorAll('tr, .urSTRow, .lsFormRow')).slice(0, 220);
            for (const row of rows) {
                const rowText = (row.innerText || '').toLowerCase();
                const matched = isExact
                    ? searchTexts.some(st => rowText.trim() === st.toLowerCase())
                    : searchTexts.some(st => rowText.includes(st.toLowerCase()));
                if (!matched) continue;

                const candidates = row.querySelectorAll('td, th, span, input, div.lsTextView, .lsTextView--design-standard');
                for (const candidate of candidates) {
                    const value = (candidate.value || candidate.innerText || '').trim();
                    if (/^\d{1,3}([.,]\d+)?\s*$/.test(value)) return value;
                }
            }
            return '';
        };

        // totalCredits (UI "ECTS" spot) <- get Total Earned Credits (Correct mapping)
        totalCredits = findValueByText(['Total Earned Credits', 'Σύνολο Πιστωτικών Μονάδων']);

        // totalGreekCredits (UI other spot) <- get Total Earned Greek Credits
        totalGreekCredits = findValueByText(['Total Earned Greek Credits', 'Σύνολο Διδακτικών Μονάδων']);

        // Fallback or if empty, try original mapping or generic "ECTS" search (but be careful not to mix them up)
        if (!totalCredits) totalCredits = findValueByText(['ECTS']); // Careful, this might be row header

        return {
            name,
            average: (average || '').replace(',', '.'),
            totalCredits: (totalCredits || '').replace(',', '.'),
            totalGreekCredits: (totalGreekCredits || '').replace(',', '.')
        };
    });
};

async function scrapeGrades(page, token) {
    Logger.info('Parsing grades and info...', null, token);

    let studentInfo = { name: '', average: '', totalCredits: '', totalGreekCredits: '' };
    let allGrades = [];
    let headers = [];
    const targetPrefix = 'https://matrix.upatras.gr/sap/bc/webdynpro/SAP/ZUPS_PIQ_ST_ACAD_WORK_OV';

    for (const f of page.frames()) {
        const url = f.url();
        if (url.startsWith(targetPrefix)) {
            Logger.info(`Found target frame: ${url}`, null, token);

            // Scrape info and grades from this specific frame
            const info = await scrapeStudentInfo(f);
            if (info && typeof info === 'object') {
                studentInfo = {
                    name: info.name || studentInfo.name,
                    average: info.average || studentInfo.average,
                    totalCredits: info.totalCredits || studentInfo.totalCredits,
                    totalGreekCredits: info.totalGreekCredits || studentInfo.totalGreekCredits
                };
            }

            const res = await scrapeFrame(f);
            if (res.grades && res.grades.length > 0) {
                allGrades = res.grades;
                headers = res.headers;
            }
            break;
        }
    }

    return {
        studentInfo,
        grades: allGrades || [],
        headers: headers || []
    };
}


module.exports = { scrapeGrades };
