import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import axios from 'axios';
import { Login } from './components/Login';
import { CaptchaModal } from './components/CaptchaModal';
import { Dashboard } from './components/Dashboard';
import type { Grade, StudentInfo } from './types';

const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001/api`;

const getOrCreateDeviceId = () => {
  const existing = localStorage.getItem('up_device_id');
  if (existing) return existing;

  let nextId = '';
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    nextId = window.crypto.randomUUID();
  } else {
    nextId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  localStorage.setItem('up_device_id', nextId);
  return nextId;
};

const detectDeviceModel = () => {
  const ua = navigator.userAgent || '';

  let os = 'Unknown OS';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  return `${browser} on ${os}`;
};

const gradeKey = (g: Grade) => `${g.code}-${g.year}-${g.semester}-${g.session || g.acadSession || ''}`;

const App: React.FC = () => {
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const deviceModel = useMemo(() => detectDeviceModel(), []);

  const [features, setFeatures] = useState({
    loaded: false,
    mongoEnabled: false,
    pushEnabled: false,
    vapidAvailable: false,
    autoSolveAvailable: false,
  });

  const [autoSolveEnabled, setAutoSolveEnabledState] = useState(() => {
    const stored = localStorage.getItem('up_auto_solve_enabled');
    return stored !== 'false';
  });

  const [activeUsername, setActiveUsername] = useState(() => localStorage.getItem('up_user') || '');
  const [sessionPasswordBase64, setSessionPasswordBase64] = useState<string | null>(() => localStorage.getItem('up_pass'));

  const [token, setToken] = useState<string | null>(null);
  const [captchaImage, setCaptchaImage] = useState<string | null>(null);
  const [captchaMessage, setCaptchaMessage] = useState<string | undefined>(undefined);
  const [selectedCourseCode, setSelectedCourseCode] = useState<string | null>(null);
  const courseOpenLockRef = React.useRef<string | null>(null);
  const [animateOut, setAnimateOut] = useState(false);

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

  const authAttempted = useRef(false);
  const isProgrammaticBack = useRef(false);
  const loginInFlightRef = useRef(false);
  const refreshKickoffRef = useRef(false);

  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
    return false;
  });

  const [loading, setLoading] = useState(false);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState(false);

  const setAutoSolveEnabled = (value: boolean) => {
    setAutoSolveEnabledState(value);
    localStorage.setItem('up_auto_solve_enabled', value ? 'true' : 'false');
  };

  const getPasswordBase64 = () => localStorage.getItem('up_pass') || sessionPasswordBase64;

  const toggleTheme = () => {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  const handleSelectCourse = React.useCallback((code: string | null) => {
    if (selectedCourseCode === code) return;

    if (code) {
      // Ignore additional open requests while a course is opening/open.
      if (selectedCourseCode || courseOpenLockRef.current) return;
      courseOpenLockRef.current = code;

      const updatedGrades = grades.map(g => (
        g.code === code ? { ...g, isNew: false } : g
      ));

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
      setSelectedCourseCode(code);
    } else {
      setAnimateOut(true);
      isProgrammaticBack.current = true;
      window.history.back();
    }
  }, [selectedCourseCode, grades]);

  useEffect(() => {
    courseOpenLockRef.current = selectedCourseCode;
  }, [selectedCourseCode]);

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

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#111827');
    } else {
      document.documentElement.classList.remove('dark');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#f3f4f6');
    }
  }, [darkMode]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    let mounted = true;
    axios.get(`${API_URL}/features`)
      .then(res => {
        if (!mounted) return;
        setFeatures({
          loaded: true,
          mongoEnabled: !!res.data?.mongoEnabled,
          pushEnabled: !!res.data?.pushEnabled,
          vapidAvailable: !!res.data?.vapidAvailable,
          autoSolveAvailable: !!res.data?.autoSolveAvailable,
        });
      })
      .catch(() => {
        if (!mounted) return;
        setFeatures({
          loaded: true,
          mongoEnabled: false,
          pushEnabled: false,
          vapidAvailable: false,
          autoSolveAvailable: false,
        });
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!features.mongoEnabled) return;

    const sendAppOpen = async (countOnlineOpen: boolean) => {
      const username = activeUsername || localStorage.getItem('up_user') || '';
      if (!username) return;

      if (!navigator.onLine) {
        if (countOnlineOpen) {
          const offline = parseInt(localStorage.getItem('up_offline_opens') || '0', 10) || 0;
          localStorage.setItem('up_offline_opens', String(offline + 1));
        }
        return;
      }

      const offlineOpenDelta = parseInt(localStorage.getItem('up_offline_opens') || '0', 10) || 0;
      try {
        await axios.post(`${API_URL}/statistics/app-open`, {
          username,
          deviceId,
          deviceModel,
          offlineOpenDelta,
          countOnlineOpen,
        });

        if (offlineOpenDelta > 0) {
          localStorage.setItem('up_offline_opens', '0');
        }
      } catch {
        // no-op
      }
    };

    sendAppOpen(true);

    const onOnline = async () => {
      const offlineOpenDelta = parseInt(localStorage.getItem('up_offline_opens') || '0', 10) || 0;
      if (offlineOpenDelta <= 0) return;
      await sendAppOpen(false);
    };

    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [features.mongoEnabled, activeUsername, deviceId, deviceModel]);

  useEffect(() => {
    if (authAttempted.current) return;
    authAttempted.current = true;

    const storedUser = localStorage.getItem('up_user');
    const storedPass = localStorage.getItem('up_pass');
    const storedCookies = localStorage.getItem('up_session_cookies');

    if (storedUser && storedPass) {
      setActiveUsername(storedUser);
      setSessionPasswordBase64(storedPass);
      setHasCredentials(true);
      setIsAutoLoggingIn(true);

      if (storedCookies) {
        refreshGrades(true);
      } else {
        handleLogin({ username: storedUser, pass: atob(storedPass), isAuto: true, isBackground: true, remember: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      } catch {
        clearInterval(interval);
        setLoading(false);
        setBackgroundLoading(false);
      }
    }, 500);
  };

  const sendLogoutToServer = async (usernameOverride?: string) => {
    const username = usernameOverride || activeUsername || localStorage.getItem('up_user') || '';
    if (!username) return;

    try {
      await axios.post(`${API_URL}/logout`, { username, deviceId });
    } catch {
      // no-op
    }
  };

  const clearLocalSession = () => {
    setToken(null);
    setGrades([]);
    setStudentInfo(null);
    setActiveUsername('');
    setSessionPasswordBase64(null);
    setIsAutoLoggingIn(false);
    setHasCredentials(false);
    setLoading(false);
    setBackgroundLoading(false);

    localStorage.removeItem('up_grades');
    localStorage.removeItem('up_studentInfo');
    localStorage.removeItem('up_user');
    localStorage.removeItem('up_pass');
    localStorage.removeItem('up_session_cookies');
    localStorage.removeItem('push_enabled');
  };

  const handleLogout = async () => {
    await sendLogoutToServer();

    try {
      const registration = await navigator.serviceWorker?.ready;
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch {
      // no-op
    }

    clearLocalSession();
  };

  const handleLogin = async ({
    username,
    pass,
    isAuto = false,
    isBackground = false,
    remember = false,
  }: {
    username: string;
    pass: string;
    isAuto?: boolean;
    isBackground?: boolean;
    remember?: boolean;
  }) => {
    if (loginInFlightRef.current) return;
    loginInFlightRef.current = true;

    if (isBackground) {
      setBackgroundLoading(true);
    } else {
      setLoading(true);
    }

    setError(null);
    setCaptchaMessage(undefined);

    try {
      const res = await axios.post(`${API_URL}/login`, {
        username,
        password: pass,
        deviceId,
        deviceModel,
      });

      if (res.data.success) {
        setHasCredentials(true);
        setActiveUsername(username);

        const passBase64 = btoa(pass);
        setSessionPasswordBase64(passBase64);

        if (remember) {
          localStorage.setItem('up_user', username);
          localStorage.setItem('up_pass', passBase64);
        } else {
          localStorage.removeItem('up_user');
          localStorage.removeItem('up_pass');
        }

        if (res.data.cookies) {
          localStorage.setItem('up_session_cookies', JSON.stringify(res.data.cookies));
        }

        setLoading(false);
        setBackgroundLoading(false);

        refreshGrades(true);
      }
      loginInFlightRef.current = false;
    } catch (err: unknown) {
      const httpErr = err as { response?: { data?: { error?: string }; status?: number } };
      const errorMsg = httpErr.response?.data?.error || 'Login failed. Please check credentials.';

      if (httpErr.response?.status === 401 && (
        errorMsg.includes('Wrong password') ||
        errorMsg.includes('Unknown username') ||
        errorMsg.includes('Invalid credentials')
      )) {
        await sendLogoutToServer(username);

        localStorage.removeItem('up_user');
        localStorage.removeItem('up_pass');
        localStorage.removeItem('up_session_cookies');
        setHasCredentials(false);
        setActiveUsername('');
        setSessionPasswordBase64(null);
        setToken(null);
      }

      if (!isAuto) {
        setError(errorMsg);
      }

      setIsAutoLoggingIn(false);
      setLoading(false);
      setBackgroundLoading(false);
      loginInFlightRef.current = false;

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

  const refreshGrades = async (isBackground = false) => {
    if (refreshKickoffRef.current) return;
    if (loading || backgroundLoading) return;
    refreshKickoffRef.current = true;

    const storedCookies = localStorage.getItem('up_session_cookies');
    if (!storedCookies) {
      const storedUser = localStorage.getItem('up_user');
      const storedPass = localStorage.getItem('up_pass');
      if (storedUser && storedPass) {
        refreshKickoffRef.current = false;
        return handleLogin({ username: storedUser, pass: atob(storedPass), isAuto: true, isBackground, remember: true });
      }
      refreshKickoffRef.current = false;
      await handleLogout();
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
      const username = activeUsername || localStorage.getItem('up_user') || '';
      const res = await axios.post(`${API_URL}/refresh-grades`, {
        cookies: JSON.parse(storedCookies),
        username,
        passwordBase64: getPasswordBase64(),
        deviceId,
        deviceModel,
        autoSolveEnabled,
      });

      if (res.data.token) {
        setToken(res.data.token);
        pollStatus(res.data.token);
      }
      refreshKickoffRef.current = false;
    } catch (err: unknown) {
      const httpErr = err as { response?: { data?: { error?: string; expired?: boolean }; status?: number } };
      if (httpErr.response?.status === 401 && httpErr.response?.data?.expired) {
        const storedUser = localStorage.getItem('up_user');
        const storedPass = localStorage.getItem('up_pass');

        if (storedUser && storedPass) {
          localStorage.removeItem('up_session_cookies');
          refreshKickoffRef.current = false;
          return handleLogin({ username: storedUser, pass: atob(storedPass), isAuto: true, isBackground, remember: true });
        }

        refreshKickoffRef.current = false;
        await handleLogout();
        setError('Session expired. Please login again.');
        return;
      }

      if (!navigator.onLine) {
        if (grades.length > 0) {
          setError('You\'re offline. Showing cached grades.');
        } else {
          setError('You\'re offline. Connect to the internet to sync.');
        }
      } else {
        setError(httpErr.response?.data?.error || 'Failed to refresh grades.');
      }

      setIsAutoLoggingIn(false);
      setLoading(false);
      setBackgroundLoading(false);
      refreshKickoffRef.current = false;
    }
  };

  const processAndSetData = (newGrades: Grade[], newInfo: StudentInfo, headers?: string[]) => {
    const oldGradesMap = new Map<string, Grade>();
    grades.forEach(g => oldGradesMap.set(gradeKey(g), g));
    const nowIso = new Date().toISOString();

    const processedGrades = newGrades.map(g => {
      const key = gradeKey(g);
      const existing = oldGradesMap.get(key);
      const hasValidGrade = !!(g.grade && g.grade.trim() !== '');

      let isNew = false;
      let dateAdded: string | null = null;
      if (existing) {
        if (hasValidGrade && existing.grade !== g.grade) {
          isNew = true;
          dateAdded = nowIso;
        } else {
          isNew = existing.isNew || false;
          dateAdded = existing.dateAdded || null;
        }
      }

      return { ...g, isNew, dateAdded };
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
    } catch (err: unknown) {
      const httpErr = err as { response?: { data?: { error?: string }; status?: number } };
      if (httpErr.response?.status === 404 || httpErr.response?.data?.error === 'Session expired') {
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
    } catch (err: unknown) {
      const httpErr = err as { response?: { data?: { error?: string }; status?: number } };
      if (httpErr.response?.status === 404 || httpErr.response?.data?.error === 'Session expired') {
        setCaptchaImage(null);
        setToken(null);
        setIsAutoLoggingIn(false);
      }

      setError(httpErr.response?.data?.error || 'Verification failed. Please try again.');
      await handleRefreshCaptcha();
      setLoading(false);
    }
  };

  const handleCancelCaptcha = () => {
    setCaptchaImage(null);
    setLoading(false);
    setIsAutoLoggingIn(false);
  };

  const latestGrades = useMemo(() => {
    const sorted = [...grades].sort((a, b) => {
      if (a.year !== b.year) return b.year.localeCompare(a.year);
      return 0;
    });

    const unique = new Map<string, Grade>();
    sorted.forEach(g => {
      if (!unique.has(g.code)) unique.set(g.code, g);
    });

    return Array.from(unique.values());
  }, [grades]);

  return (
    <div className="min-h-screen font-sans text-gray-900 bg-gray-50 transition-colors duration-300 dark:bg-gray-900 dark:text-gray-100">
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
          autoSolveEnabled={autoSolveEnabled}
          onAutoSolveChange={setAutoSolveEnabled}
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
            apiUrl={API_URL}
            username={activeUsername || localStorage.getItem('up_user') || ''}
            deviceId={deviceId}
            deviceModel={deviceModel}
            autoSolveEnabled={autoSolveEnabled}
            onAutoSolveChange={setAutoSolveEnabled}
            passwordBase64={getPasswordBase64()}
            mongoEnabled={features.mongoEnabled}
            pushEnabled={features.pushEnabled}
            autoSolveAvailable={features.autoSolveAvailable}
          />
        </>
      )}
    </div>
  );
};

export default App;
