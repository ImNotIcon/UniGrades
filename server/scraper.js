
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

        // Average Grade
        let average = '';
        // Look for "Δείκτες Απόδοσης" table
        const tables = Array.from(document.querySelectorAll('table'));
        const kpiTable = tables.find(t => t.innerText && t.innerText.includes('Δείκτες Απόδοσης'));
        if (kpiTable) {
            const rows = Array.from(kpiTable.querySelectorAll('tr'));
            const gradeRow = rows.find(r => r.innerText.includes('Βαθμός') && !r.innerText.includes('ECTS'));
            if (gradeRow) {
                const cells = Array.from(gradeRow.cells || gradeRow.querySelectorAll('td'));
                // Assuming cell structure: Name | Type | Value | Scale | ECTS
                // The value is usually in the 3rd cell (index 2)
                const valCell = cells.find(c => /^\d+,\d+$/.test(c.innerText.trim()));
                if (valCell) average = valCell.innerText.trim();
                else if (cells[2]) average = cells[2].innerText.trim();
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

            // 2. Try generic traversal if no ID link found
            const allElements = Array.from(document.querySelectorAll('*'));
            for (const el of allElements) {
                const text = (el.innerText || '').toLowerCase();
                if (searchTexts.some(st => text.includes(st.toLowerCase()))) {
                    let current = el;
                    // Look around for a number
                    // 1. Next Sibling
                    if (current.nextElementSibling) {
                        const nextText = current.nextElementSibling.innerText || current.nextElementSibling.value || '';
                        if (/^\d{1,3}([.,]\d+)?\s*$/.test(nextText.trim())) return nextText.trim();
                    }
                    // 2. Parent's Next Sibling
                    if (current.parentElement && current.parentElement.nextElementSibling) {
                        const parentNextText = current.parentElement.nextElementSibling.innerText || current.parentElement.nextElementSibling.value || '';
                        if (/^\d{1,3}([.,]\d+)?\s*$/.test(parentNextText.trim())) return parentNextText.trim();
                    }
                    // 3. Children of Parent
                    if (current.parentElement) {
                        const inputs = current.parentElement.querySelectorAll('input, span, div');
                        for (const inp of inputs) {
                            const val = inp.value || inp.innerText || '';
                            if (val && val !== text && /^\d{1,3}([.,]\d+)?\s*$/.test(val.trim())) return val.trim();
                        }
                    }
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

async function scrapeGrades(page) {
    console.log('Parsing grades and info...');

    let studentInfo = { name: '', average: '', totalCredits: '', totalGreekCredits: '' };
    let allGrades = [];
    let headers = [];
    const targetPrefix = 'https://matrix.upatras.gr/sap/bc/webdynpro/SAP/ZUPS_PIQ_ST_ACAD_WORK_OV';

    for (const f of page.frames()) {
        const url = f.url();
        if (url.startsWith(targetPrefix)) {
            console.log(`Found target frame: ${url}`);

            // Scrape info and grades from this specific frame
            const info = await scrapeStudentInfo(f);
            if (info.name) studentInfo = info;

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
