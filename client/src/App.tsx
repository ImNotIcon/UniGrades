import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import axios from 'axios';
import { Login } from './components/Login';
import { CaptchaModal } from './components/CaptchaModal';
import { Dashboard } from './components/Dashboard';
import type { Grade, StudentInfo } from './types';

const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001/api`;


const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [captchaImage, setCaptchaImage] = useState<string | null>(null);
  const [captchaMessage, setCaptchaMessage] = useState<string | undefined>(undefined);
  const [selectedCourseCode, setSelectedCourseCode] = useState<string | null>(null);
  const [animateOut, setAnimateOut] = useState(false);

  // Initialize state directly from local storage to prevent flash of login screen
  const [grades, setGrades] = useState<Grade[]>(() => {
    const saved = localStorage.getItem('up_grades');
    return saved ? JSON.parse(saved) : [];
  });
  const [studentInfo, setStudentInfo] = useState<StudentInfo | null>(() => {
    const saved = localStorage.getItem('up_studentInfo');
    return saved ? JSON.parse(saved) : null;
  });
  const [hasCredentials, setHasCredentials] = useState(() => {
    return !!(localStorage.getItem('up_user') && localStorage.getItem('up_pass'));
  });

  const authAttempted = React.useRef(false);
  const isProgrammaticBack = useRef(false);



  const handleSelectCourse = React.useCallback((code: string | null) => {
    if (selectedCourseCode === code) return;
    if (code) {
      // Clear notification for this course
      const updatedGrades = grades.map(g =>
        g.code === code ? { ...g, isNew: false } : g
      );

      // Only update if something changed to avoid unnecessary re-renders
      if (updatedGrades.some((g, i) => g.isNew !== grades[i].isNew)) {
        setGrades(updatedGrades);
        localStorage.setItem('up_grades', JSON.stringify(updatedGrades));
      }

      setAnimateOut(false);
      if (selectedCourseCode) {
        window.history.replaceState({ course: code }, '');
      } else {
        window.history.pushState({ course: code }, '');
      }
      document.body.style.overflow = 'hidden';
      setSelectedCourseCode(code);
    } else {
      setAnimateOut(true);
      isProgrammaticBack.current = true;
      window.history.back();
    }
  }, [selectedCourseCode, grades]);

  useEffect(() => {
    const onPopState = () => {
      if (!isProgrammaticBack.current) {
        setAnimateOut(false);
      }
      isProgrammaticBack.current = false;
      setSelectedCourseCode(window.history.state?.course || null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Theme State — only persist when the user explicitly toggles
  const [darkMode, setDarkMode] = useState(() => {
    // Check local storage first (user has explicitly chosen)
    const stored = localStorage.getItem('theme');
    if (stored === 'dark') return true;
    if (stored === 'light') return false;

    // No stored preference — follow OS default (don't store it)
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;

    return false; // Default to light
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#111827');
    } else {
      document.documentElement.classList.remove('dark');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#f3f4f6');
    }
  }, [darkMode]);

  const toggleTheme = () => {
    const next = !darkMode;
    setDarkMode(next);
    // Only persist once the user has explicitly toggled
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  const [loading, setLoading] = useState(false);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState(false);

  // Auto-dismiss error
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // On mount: if we have stored credentials, auto-login and refresh grades
  useEffect(() => {
    if (authAttempted.current) return;
    authAttempted.current = true;

    const storedUser = localStorage.getItem('up_user');
    const storedPass = localStorage.getItem('up_pass');
    const storedCookies = localStorage.getItem('up_session_cookies');

    if (storedUser && storedPass) {
      setIsAutoLoggingIn(true);

      // If we have cookies, try refreshing grades directly (skip login)
      if (storedCookies) {
        refreshGrades(true);
      } else {
        // No cookies yet, need to login first
        handleLogin({ username: storedUser, pass: atob(storedPass), isAuto: true, isBackground: true });
      }
    }
  }, []);

  /* Polling logic for async scraping and captcha. */
  const pollStatus = async (pollToken: string) => {
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${API_URL}/status?token=${pollToken}`);

        if (res.data.status === 'completed') {
          clearInterval(interval);
          if (res.data.cookies) {
            localStorage.setItem('up_session_cookies', JSON.stringify(res.data.cookies));
          }
          processAndSetData(res.data.grades || [], res.data.studentInfo, res.data.headers);
          setLoading(false);
          setBackgroundLoading(false);
        } else if (res.data.status === 'manual_captcha') {
          clearInterval(interval);
          setCaptchaImage(res.data.captchaImage);
          setCaptchaMessage(res.data.message);
          if (res.data.token) setToken(res.data.token);
          setLoading(false);
          setBackgroundLoading(false);
        } else if (res.data.status === 'error') {
          clearInterval(interval);
          setError(res.data.error || 'Sync failed.');
          setLoading(false);
          setBackgroundLoading(false);
        } else if (res.data.status === 'expired') {
          clearInterval(interval);
          setCaptchaImage(null);
          setToken(null);
          setLoading(false);
          setBackgroundLoading(false);
          setIsAutoLoggingIn(false);
          setError('Session expired.');
        }
      } catch (e) {
        console.error('Polling error', e);
        clearInterval(interval);
        setLoading(false);
        setBackgroundLoading(false);
      }
    }, 2500);
  };

  // Login: only authenticates, returns cookies. Then triggers grade refresh.
  const handleLogin = async ({ username, pass, isAuto = false, isBackground = false, remember = false }: { username: string; pass: string; isAuto?: boolean, isBackground?: boolean, remember?: boolean }) => {
    if (isBackground) {
      setBackgroundLoading(true);
    } else {
      setLoading(true);
    }
    setError(null);
    setCaptchaMessage(undefined);

    try {
      const res = await axios.post(`${API_URL}/login`, { username, password: pass });

      if (res.data.success) {
        setHasCredentials(true);

        // Save credentials only after successful login
        if (remember) {
          localStorage.setItem('up_user', username);
          localStorage.setItem('up_pass', btoa(pass));
        }

        // Store cookies from login
        if (res.data.cookies) {
          localStorage.setItem('up_session_cookies', JSON.stringify(res.data.cookies));
        }

        if (!isBackground) setLoading(false);
        else setBackgroundLoading(false);

        // After login, always refresh as background since we're now on the Dashboard
        refreshGrades(true);
      }
    } catch (err: any) {
      console.error(err);
      const errorMsg = err.response?.data?.error || 'Login failed. Please check credentials.';

      // If credentials are definitively invalid, force logout/reset
      if (err.response?.status === 401 && (
        errorMsg.includes('Wrong password') ||
        errorMsg.includes('Unknown username') ||
        errorMsg.includes('Invalid credentials')
      )) {
        localStorage.removeItem('up_user');
        localStorage.removeItem('up_pass');
        localStorage.removeItem('up_session_cookies');
        setHasCredentials(false);
        setToken(null);
        setError(errorMsg); // Show why they were kicked out
      } else if (!isAuto) {
        setError(errorMsg);
      }

      setIsAutoLoggingIn(false);
      setLoading(false);
      setBackgroundLoading(false);

      if (!navigator.onLine) {
        if (grades.length > 0) {
          setError('You\'re offline. Showing cached grades.');
        } else {
          setError('You\'re offline. Connect to the internet to login.');
        }
      } else {
        setError(errorMsg);
      }
    }
  };

  // Refresh Grades: uses stored cookies to fetch grades
  const refreshGrades = async (isBackground = false) => {
    if (loading || backgroundLoading) return;

    const storedCookies = localStorage.getItem('up_session_cookies');
    if (!storedCookies) {
      // No cookies, need to login first
      const storedUser = localStorage.getItem('up_user');
      const storedPass = localStorage.getItem('up_pass');
      if (storedUser && storedPass) {
        return handleLogin({ username: storedUser, pass: atob(storedPass), isAuto: true, isBackground });
      }
      handleLogout();
      setError('No session cookies. Please login first.');
      return;
    }

    if (isBackground) {
      setBackgroundLoading(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await axios.post(`${API_URL}/refresh-grades`, {
        cookies: JSON.parse(storedCookies)
      });

      if (res.data.token) {
        setToken(res.data.token);
        pollStatus(res.data.token);
      }
    } catch (err: any) {
      console.error(err);

      // If session expired, re-login automatically
      if (err.response?.status === 401 && err.response?.data?.expired) {
        console.log('Session expired, re-logging in...');
        const storedUser = localStorage.getItem('up_user');
        const storedPass = localStorage.getItem('up_pass');
        if (storedUser && storedPass) {
          localStorage.removeItem('up_session_cookies');
          return handleLogin({ username: storedUser, pass: atob(storedPass), isAuto: true, isBackground });
        } else {
          handleLogout();
          setError('Session expired. Please login again.');
          return;
        }
      }

      if (!navigator.onLine) {
        if (grades.length > 0) {
          setError('You\'re offline. Showing cached grades.');
        } else {
          setError('You\'re offline. Connect to the internet to sync.');
        }
      } else {
        setError(err.response?.data?.error || 'Failed to refresh grades.');
      }
      setIsAutoLoggingIn(false);
      setLoading(false);
      setBackgroundLoading(false);
    }
  };

  const processAndSetData = (newGrades: Grade[], newInfo: StudentInfo, headers?: string[]) => {
    // We want to replace local grades with the fresh list, but keep track of what's "new"
    // "New" means it wasn't in the previous list, OR it was already marked new and hasn't been cleared.

    const oldGradesMap = new Map<string, Grade>();
    // Key by unique properties to identify the "same" grade entry
    const createKey = (g: Grade) => `${g.code}-${g.year}-${g.semester}`;

    if (grades.length > 0) {
      grades.forEach(g => oldGradesMap.set(createKey(g), g));
    }

    const processedGrades = newGrades.map(g => {
      const key = createKey(g);
      const existing = oldGradesMap.get(key);
      let isNew = false;

      // Rule 1: If no previous grades existed, nothing is "new" (initial population).
      if (grades.length === 0) {
        isNew = false;
      } else {
        // Rule 2: Only grades with actual values qualify as new
        const hasValidGrade = g.grade && g.grade.trim() !== "";

        if (existing) {
          // If value or status changed, it's new (if valid)
          if (existing.grade !== g.grade || existing.status !== g.status) {
            if (hasValidGrade) isNew = true;
          } else {
            // Otherwise preserve existing state
            isNew = existing.isNew || false;
          }
        } else {
          // New entry in list
          if (hasValidGrade) isNew = true;
        }
      }

      return { ...g, isNew };
    });

    setGrades(processedGrades);
    setStudentInfo(newInfo);

    localStorage.setItem('up_grades', JSON.stringify(processedGrades));
    localStorage.setItem('up_studentInfo', JSON.stringify(newInfo));

    if (headers && headers.length > 0) {
      localStorage.setItem('up_raw_headers', JSON.stringify(headers));
    }

    setIsAutoLoggingIn(false);
    setLoading(false);
    setBackgroundLoading(false);
  };

  const handleRefreshCaptcha = async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setCaptchaMessage(undefined);
    try {
      const res = await axios.post(`${API_URL}/refresh-captcha`, { token });
      if (res.data.captchaImage) {
        setCaptchaImage(res.data.captchaImage);
      }
    } catch (err: any) {
      console.error(err);
      if (err.response?.status === 404 || err.response?.data?.error === 'Session expired') {
        setCaptchaImage(null);
        setToken(null);
        setIsAutoLoggingIn(false);
        setError('Session expired. Please try again.');
        return;
      }
      setError('Failed to refresh captcha.');
    } finally {
      setLoading(false);
    }
  };

  const handleCaptchaSolve = async (answer: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await axios.post(`${API_URL}/solve-captcha`, { token, answer });

      if (res.data.status === 'loading') {
        if (res.data.cookies) {
          localStorage.setItem('up_session_cookies', JSON.stringify(res.data.cookies));
        }
        setCaptchaImage(null);
        setBackgroundLoading(true);
        setLoading(false);
        pollStatus(token);
      } else if (res.data.success && res.data.grades) {
        if (res.data.cookies) {
          localStorage.setItem('up_session_cookies', JSON.stringify(res.data.cookies));
        }
        processAndSetData(res.data.grades, res.data.studentInfo, res.data.headers);
        setCaptchaImage(null);
        setLoading(false);
      }
    } catch (err: any) {
      console.error(err);
      if (err.response?.status === 404 || err.response?.data?.error === 'Session expired') {
        setCaptchaImage(null);
        setToken(null);
        setIsAutoLoggingIn(false);
      }
      setError(err.response?.data?.error || 'Verification failed. Please try again.');
      // Don't close modal, just refresh for new attempt
      await handleRefreshCaptcha();
      setLoading(false);
    }
  };

  const handleCancelCaptcha = () => {
    setCaptchaImage(null);
    setLoading(false);
    setIsAutoLoggingIn(false);
  };

  const handleLogout = () => {
    axios.post(`${API_URL}/logout`).catch(console.error);
    setToken(null);
    setGrades([]);
    setStudentInfo(null);
    localStorage.removeItem('up_grades');
    localStorage.removeItem('up_studentInfo');
    localStorage.removeItem('up_user');
    localStorage.removeItem('up_pass');
    localStorage.removeItem('up_session_cookies');
    setIsAutoLoggingIn(false);
    setHasCredentials(false);
    setLoading(false);
    setBackgroundLoading(false);
  };

  // Filter latest grades
  const latestGrades = useMemo(() => {
    const sorted = [...grades].sort((a, b) => {
      if (a.year !== b.year) return b.year.localeCompare(a.year);
      return 0;
    });
    const unique = new Map();
    sorted.forEach(g => {
      if (!unique.has(g.code)) unique.set(g.code, g);
    });
    return Array.from(unique.values());
  }, [grades]);

  return (
    <div className="min-h-screen font-sans text-gray-900 bg-gray-50 transition-colors duration-300 dark:bg-gray-900 dark:text-gray-100">
      {/* Error Toast */}
      {/* Error Toast */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            transition={{ duration: 0.2 }}
            className="fixed top-4 left-1/2 z-[70] bg-red-50 text-red-600 px-8 py-3 min-w-[20rem] rounded-full shadow-lg border border-red-100 flex items-center justify-between gap-4 backdrop-blur-md"
          >
            <span>⚠️</span> {error}
            <button
              onClick={() => setError(null)}
              className="ml-2 w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-100 text-xl font-bold hover:text-red-800 transition-colors"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {!token && !hasCredentials && grades.length === 0 && !isAutoLoggingIn ? (
        <Login
          loading={loading}
          darkMode={darkMode}
          toggleTheme={toggleTheme}
          onLogin={({ username, pass, remember }) => {
            handleLogin({ username, pass, remember });
          }}
        />
      ) : (
        <>
          <AnimatePresence>
            {captchaImage && (
              <CaptchaModal
                key="captcha-modal"
                imageSrc={captchaImage}
                onSolve={handleCaptchaSolve}
                onCancel={handleCancelCaptcha}
                onRefresh={handleRefreshCaptcha}
                message={captchaMessage}
                isLoading={loading}
              />
            )}
          </AnimatePresence>

          <Dashboard
            allGrades={latestGrades}
            fullHistory={grades}
            studentInfo={studentInfo}
            onLogout={handleLogout}
            onRefresh={() => refreshGrades(true)}
            isLoading={loading}
            isBackgroundLoading={backgroundLoading}
            darkMode={darkMode}
            toggleTheme={toggleTheme}
            selectedCourseCode={selectedCourseCode}
            onSelectCourse={handleSelectCourse}
            animateOut={animateOut}
          />
        </>
      )}
    </div>
  );
};

export default App;
