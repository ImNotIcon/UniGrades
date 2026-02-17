import React, { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, Trash2, X, Loader2 } from 'lucide-react';

interface DeviceEntry {
    deviceId: string;
    model: string;
    lastSeen: string | null;
    isCurrent: boolean;
}

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    apiUrl: string;
    darkMode: boolean;
    mongoEnabled: boolean;
    pushEnabled: boolean;
    username: string;
    deviceId: string;
    deviceModel: string;
    autoSolveEnabled: boolean;
    onAutoSolveChange: (enabled: boolean) => void;
    passwordBase64: string | null;
}

const INTERVAL_OPTIONS = [
    { label: '10 mins', value: 10 },
    { label: '30 mins', value: 30 },
    { label: '1 hour', value: 60 },
    { label: '6 hours', value: 360 },
    { label: '12 hours', value: 720 },
    { label: '1 day', value: 1440 },
];

const supportsPush = () => (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
);

const urlBase64ToUint8Array = (base64String: string): ArrayBuffer => {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray.buffer;
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    apiUrl,
    darkMode,
    mongoEnabled,
    pushEnabled,
    username,
    deviceId,
    deviceModel,
    autoSolveEnabled,
    onAutoSolveChange,
    passwordBase64,
}) => {
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [notifEnabled, setNotifEnabled] = useState(false);
    const [hasSubscriptionDoc, setHasSubscriptionDoc] = useState(false);
    const [intervalMinutes, setIntervalMinutes] = useState(30);
    const [devices, setDevices] = useState<DeviceEntry[]>([]);
    const [showConsent, setShowConsent] = useState(false);
    const [consentAccepted, setConsentAccepted] = useState(false);

    const canUsePush = useMemo(() => supportsPush(), []);
    const loadSettings = async () => {
        if (!isOpen) return;

        if (!mongoEnabled || !username) {
            setNotifEnabled(false);
            setHasSubscriptionDoc(false);
            setDevices([]);
            setIntervalMinutes(30);
            return;
        }

        setLoading(true);
        try {
            const res = await fetch(
                `${apiUrl}/notifications/settings?username=${encodeURIComponent(username)}&deviceId=${encodeURIComponent(deviceId)}`
            );
            const data = await res.json();

            if (data.featureDisabled) {
                setNotifEnabled(false);
                setHasSubscriptionDoc(false);
                setDevices([]);
                setIntervalMinutes(30);
                return;
            }

            setNotifEnabled(!!data.currentDeviceSubscribed);
            setHasSubscriptionDoc(!!data.hasSubscriptionDoc);
            setDevices(Array.isArray(data.devices) ? data.devices : []);
            setIntervalMinutes(Number(data.checkIntervalMinutes) || 30);

            localStorage.setItem('push_enabled', data.currentDeviceSubscribed ? 'true' : 'false');
        } catch {
            // no-op
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSettings();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, mongoEnabled, username, deviceId]);

    const getOrCreateBrowserSubscription = async () => {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) return existing;

        const vapidRes = await fetch(`${apiUrl}/push/vapid-key`);
        const vapidData = await vapidRes.json();
        if (!vapidData.publicKey) {
            throw new Error('No VAPID key configured on server.');
        }

        return registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey),
        });
    };

    const submitSubscription = async (consent: boolean) => {
        if (!username || !deviceId) return;

        if (!passwordBase64) {
            window.alert('Password is required to enable notifications. Please login again and try once more.');
            return;
        }

        setSaving(true);
        try {
            const browserSub = await getOrCreateBrowserSubscription();
            const response = await fetch(`${apiUrl}/notifications/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    passwordBase64,
                    deviceId,
                    deviceModel,
                    pushSubscription: browserSub.toJSON(),
                    checkIntervalMinutes: intervalMinutes,
                    consentAccepted: consent,
                    autoSolveEnabled: true,
                }),
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to enable notifications.');
            }

            setNotifEnabled(true);
            localStorage.setItem('push_enabled', 'true');
            await loadSettings();
        } catch (error: unknown) {
            const err = error as { message?: string };
            window.alert(err.message || 'Failed to enable notifications.');
        } finally {
            setSaving(false);
        }
    };

    const handleEnableNotifications = async () => {
        if (!mongoEnabled) return;
        if (!pushEnabled) {
            window.alert('Push notifications are not configured on this server.');
            return;
        }
        if (!canUsePush) {
            window.alert('Push notifications are not supported in this browser.');
            return;
        }

        if (!autoSolveEnabled) {
            const enable = window.confirm('Auto solve is required for push notifications. Enable auto solve now?');
            if (!enable) return;
            onAutoSolveChange(true);
        }

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            window.alert('Notification permission was not granted.');
            return;
        }

        if (!hasSubscriptionDoc) {
            setShowConsent(true);
            return;
        }

        await submitSubscription(false);
    };

    const handleDisableNotifications = async () => {
        if (!username || !deviceId) return;

        setSaving(true);
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
            }

            await fetch(`${apiUrl}/notifications/unsubscribe-device`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, deviceId }),
            });

            setNotifEnabled(false);
            localStorage.setItem('push_enabled', 'false');
            await loadSettings();
        } catch {
            window.alert('Failed to disable notifications.');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteDevice = async (targetDeviceId: string) => {
        const confirmed = window.confirm('Delete notifications for this device?');
        if (!confirmed) return;

        setSaving(true);
        try {
            await fetch(`${apiUrl}/notifications/unsubscribe-device`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, deviceId: targetDeviceId }),
            });

            if (targetDeviceId === deviceId) {
                const registration = await navigator.serviceWorker.ready;
                const subscription = await registration.pushManager.getSubscription();
                if (subscription) await subscription.unsubscribe();
                localStorage.setItem('push_enabled', 'false');
                setNotifEnabled(false);
            }

            await loadSettings();
        } catch {
            window.alert('Failed to delete device subscription.');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteAll = async () => {
        const confirmed = window.confirm('Delete all notification subscriptions for this account?');
        if (!confirmed) return;

        setSaving(true);
        try {
            await fetch(`${apiUrl}/notifications/unsubscribe-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username }),
            });

            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) await subscription.unsubscribe();

            setNotifEnabled(false);
            localStorage.setItem('push_enabled', 'false');
            await loadSettings();
        } catch {
            window.alert('Failed to delete all subscriptions.');
        } finally {
            setSaving(false);
        }
    };

    const handleIntervalChange = async (next: number) => {
        setIntervalMinutes(next);

        if (!hasSubscriptionDoc || !mongoEnabled || !username) {
            return;
        }

        try {
            const res = await fetch(`${apiUrl}/notifications/interval`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, checkIntervalMinutes: next }),
            });
            const data = await res.json();
            if (res.ok && data.checkIntervalMinutes) {
                setIntervalMinutes(data.checkIntervalMinutes);
            }
        } catch {
            // no-op
        }
    };

    const handleAutoSolveToggle = async (enabled: boolean) => {
        if (enabled) {
            onAutoSolveChange(true);
            return;
        }

        if (notifEnabled) {
            const disableAnyway = window.confirm(
                'Auto solve is necessary for push notifications. Disable it anyway and remove notifications from this device?'
            );

            if (!disableAnyway) {
                return;
            }

            await handleDisableNotifications();
        }

        onAutoSolveChange(false);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={saving ? undefined : onClose}
            />

            <div className={`relative z-10 w-full max-w-2xl rounded-3xl border shadow-2xl ${darkMode ? 'bg-gray-900 border-gray-700 text-white' : 'bg-white border-gray-100 text-gray-900'}`}>
                <div className={`flex items-center justify-between px-6 py-5 border-b ${darkMode ? 'border-gray-700' : 'border-gray-100'}`}>
                    <h3 className="text-xl font-black tracking-tight">Settings</h3>
                    <button
                        onClick={onClose}
                        disabled={saving}
                        className={`p-2 rounded-full ${darkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-100'} transition-colors`}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="px-6 py-5 space-y-6 max-h-[75vh] overflow-y-auto">
                    <div className={`rounded-2xl p-4 border ${darkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-100 bg-gray-50'}`}>
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <p className="text-sm font-bold uppercase tracking-wider opacity-60">Auto Solve</p>
                                <p className="text-sm opacity-80">Required for push notifications.</p>
                            </div>

                            <label className="inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={autoSolveEnabled}
                                    onChange={(e) => handleAutoSolveToggle(e.target.checked)}
                                    disabled={saving}
                                />
                                <div className={`w-12 h-7 rounded-full transition ${autoSolveEnabled ? 'bg-indigo-600' : 'bg-gray-400'} relative`}>
                                    <span className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full transition ${autoSolveEnabled ? 'translate-x-5' : ''}`} />
                                </div>
                            </label>
                        </div>
                    </div>

                    {!mongoEnabled ? (
                        <div className={`rounded-2xl p-4 border text-sm ${darkMode ? 'border-gray-700 bg-gray-800/60 text-gray-300' : 'border-gray-100 bg-gray-50 text-gray-600'}`}>
                            Server-side notifications and statistics are disabled because MongoDB is not configured.
                        </div>
                    ) : (
                        <>
                            <div className={`rounded-2xl p-4 border ${darkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-100 bg-gray-50'}`}>
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <p className="text-sm font-bold uppercase tracking-wider opacity-60">Push Notifications</p>
                                        <p className="text-sm opacity-80">Enable alerts for changed grade values.</p>
                                    </div>

                                    <button
                                        onClick={notifEnabled ? handleDisableNotifications : handleEnableNotifications}
                                        disabled={saving || loading || !username}
                                        className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 ${notifEnabled
                                            ? 'bg-amber-500 text-white hover:bg-amber-600'
                                            : 'bg-indigo-600 text-white hover:bg-indigo-700'} disabled:opacity-50 disabled:cursor-not-allowed`}
                                    >
                                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : notifEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                                        {notifEnabled ? 'Disable' : 'Enable'}
                                    </button>
                                </div>
                            </div>

                            <div className={`rounded-2xl p-4 border ${darkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-100 bg-gray-50'}`}>
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <p className="text-sm font-bold uppercase tracking-wider opacity-60">Grades Check Interval</p>
                                        <p className="text-sm opacity-80">Used by the server for periodic checks.</p>
                                    </div>

                                    <select
                                        value={intervalMinutes}
                                        onChange={(e) => handleIntervalChange(Number(e.target.value))}
                                        disabled={saving || loading}
                                        className={`px-3 py-2 rounded-xl border text-sm font-semibold ${darkMode ? 'bg-gray-900 border-gray-700 text-white' : 'bg-white border-gray-200 text-gray-800'}`}
                                    >
                                        {INTERVAL_OPTIONS.map(option => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className={`rounded-2xl p-4 border ${darkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-100 bg-gray-50'}`}>
                                <div className="flex items-center justify-between mb-3">
                                    <p className="text-sm font-bold uppercase tracking-wider opacity-60">Subscribed Devices</p>
                                    <button
                                        onClick={handleDeleteAll}
                                        disabled={saving || devices.length === 0}
                                        className="text-xs font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-40"
                                    >
                                        Delete All
                                    </button>
                                </div>

                                <div className="space-y-2">
                                    {loading ? (
                                        <div className="text-sm opacity-70 flex items-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin" /> Loading devices...
                                        </div>
                                    ) : devices.length === 0 ? (
                                        <div className="text-sm opacity-70">No device subscriptions found.</div>
                                    ) : devices.map(device => (
                                        <div
                                            key={device.deviceId}
                                            className={`flex items-center justify-between gap-4 rounded-xl p-3 border ${device.isCurrent
                                                ? (darkMode ? 'border-indigo-500 bg-indigo-500/10' : 'border-indigo-300 bg-indigo-50')
                                                : (darkMode ? 'border-gray-700 bg-gray-900/60' : 'border-gray-200 bg-white')}`}
                                        >
                                            <div className="min-w-0">
                                                <p className="text-sm font-bold truncate">{device.model || 'Unknown device'}</p>
                                                <p className="text-xs opacity-70 truncate">
                                                    {device.isCurrent ? 'Current device' : `Device: ${device.deviceId}`}
                                                </p>
                                                <p className="text-xs opacity-60">
                                                    Last seen: {device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'Unknown'}
                                                </p>
                                            </div>

                                            <button
                                                onClick={() => handleDeleteDevice(device.deviceId)}
                                                disabled={saving}
                                                className="p-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-40"
                                                title="Delete device subscription"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {showConsent && (
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-6 rounded-3xl">
                        <div className={`w-full max-w-lg rounded-2xl border p-5 ${darkMode ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}>
                            <h4 className="text-lg font-black mb-3">Notification Consent</h4>
                            <p className="text-sm leading-relaxed opacity-90 mb-4">
                                Enabling push notifications requires storing your password on our server for periodic grade checks.
                                Disabling notifications removes this data from our servers.
                            </p>

                            <label className="flex items-start gap-3 text-sm mb-4">
                                <input
                                    type="checkbox"
                                    className="mt-1"
                                    checked={consentAccepted}
                                    onChange={(e) => setConsentAccepted(e.target.checked)}
                                />
                                <span>I understand and accept this storage requirement for notifications.</span>
                            </label>

                            <div className="flex justify-end gap-3">
                                <button
                                    className={`px-4 py-2 rounded-xl text-sm font-bold ${darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'}`}
                                    onClick={() => {
                                        setShowConsent(false);
                                        setConsentAccepted(false);
                                    }}
                                    disabled={saving}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="px-4 py-2 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                                    disabled={!consentAccepted || saving}
                                    onClick={async () => {
                                        await submitSubscription(true);
                                        setShowConsent(false);
                                        setConsentAccepted(false);
                                    }}
                                >
                                    Continue
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
