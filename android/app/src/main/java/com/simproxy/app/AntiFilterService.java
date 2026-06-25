package com.simproxy.app;

import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.annotation.Keep;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * AntiFilterService — лёгкий фоновый сервис Happ архитектуры.
 *
 * Назначение:
 * 1. Запускает Xray-ядро при подключении VPN и захватывает живое TCP-соединение
 * 2. Остаётся активным даже если основной VPN выключен (TCP не перебирается ISP)
 * 3. Обеспечивает SOCKS-пинги через AntiFilter-прокси
 * 4. Отправляет keep-alive пинги через SOCKS для поддержания соединения живым
 *
 * Архитектура:
 * - Работает в фоне с FOREGROUND_SERVICE
 * - Переиспользует уже запущенный Xray из VpnServiceImpl или запускает собственный
 * - Мониторит состояние сети и автоматически переподключается
 * - Минимизирует использование батареи через оптимизированные интервалы пингов
 */
@Keep
public class AntiFilterService extends Service {
    private static final String TAG = "AntiFilterService";
    private static final String CHANNEL_ID = "antifilter_service";
    private static final int NOTIFICATION_ID = 2;

    private static volatile AntiFilterService instance = null;
    private static volatile boolean isRunning = false;
    private static volatile boolean userStopped = false;
    private static volatile int activeSocksPort = 0;

    // SOCKS пинг параметры
    private static final String PING_HOST = "1.1.1.1"; // Cloudflare DNS — всегда доступен
    private static final int PING_INTERVAL_SECONDS = 45; // Пинг каждые 45 сек (баланс между живостью и батареей)
    private static final int PING_TIMEOUT_SECONDS = 5;
    private static final int MAX_RETRY_ATTEMPTS = 3;

    private NotificationManager notificationManager;
    private ScheduledExecutorService pingExecutor;
    private AtomicBoolean shouldKeepRunning = new AtomicBoolean(false);
    public volatile long lastPingTime = 0;
    public volatile boolean lastPingSuccess = false;

    public static AntiFilterService getInstance() {
        return instance;
    }

    public static boolean isServiceRunning() {
        return isRunning && instance != null;
    }

    public static int getActiveSocksPort() {
        return activeSocksPort;
    }

    public static void markUserStopped() {
        userStopped = true;
    }

    public static void markStarting() {
        userStopped = false;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "AntiFilterService.onCreate()");
        instance = this;
        notificationManager = getSystemService(NotificationManager.class);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "AntiFilterService.onStartCommand()");
        userStopped = false;
        shouldKeepRunning.set(true);

        if (!isRunning) {
            isRunning = true;
            startForegroundNotification();
            initializeSocksProxy();
            startKeepAlivePings();
        }

        return START_STICKY; // Перезапуск сервиса при убийстве системой
    }

    /**
     * Инициализирует SOCKS прокси:
     * 1. Если VpnServiceImpl запущен и Xray работает — переиспользует его SOCKS порт
     * 2. Если нет — запускает собственное лёгкое Xray-ядро в фоне
     * 3. Мониторит доступность прокси и переподключается при необходимости
     */
    private void initializeSocksProxy() {
        new Thread(() -> {
            try {
                // Попытка получить уже работающий SOCKS от VpnServiceImpl
                VpnServiceImpl vpnService = VpnServiceImpl.getInstance();
                if (vpnService != null) {
                    activeSocksPort = vpnService.getSocksPort();
                    if (activeSocksPort > 0 && isPortAccessible(activeSocksPort)) {
                        Log.i(TAG, "Using SOCKS from VpnServiceImpl on port " + activeSocksPort);
                        return;
                    }
                }

                // VPN не запущен — порт неизвестен, пинги будут пропущены до запуска VPN
                Log.i(TAG, "VPN not running, SOCKS port unknown — pings suspended");

            } catch (Exception e) {
                Log.e(TAG, "Error initializing SOCKS proxy", e);
            }
        }).start();
    }

    /**
     * Запускает фоновый поток keep-alive пингов через SOCKS.
     * Пинги идут через прокси, что:
     * - Доказывает прокси работающим
     * - Поддерживает TCP-соединение живым
     * - Препятствует закрытию соединения ISP'ом
     */
    private void startKeepAlivePings() {
        if (pingExecutor != null) return;

        pingExecutor = Executors.newScheduledThreadPool(1);
        pingExecutor.scheduleAtFixedRate(
            this::performSocksPing,
            5,                     // первый пинг через 5 сек — дать SOCKS порту открыться
            PING_INTERVAL_SECONDS,
            TimeUnit.SECONDS
        );
        Log.i(TAG, "Keep-alive SOCKS pings started");
    }

    // Пинг через raw SOCKS5 + HTTP GET (та же схема что NativeBridge.httpGetViaSocks).
    // HttpURLConnection через SOCKS5 ненадёжен на некоторых версиях Android и не
    // поддерживает удалённый DNS-резолв — прямой SOCKS-диалог работает везде.
    private void performSocksPing() {
        if (!shouldKeepRunning.get() || activeSocksPort <= 0) return;

        // Обновляем порт из живого VPN при каждом пинге (VPN мог перезапуститься)
        VpnServiceImpl vpn = VpnServiceImpl.getInstance();
        if (vpn != null && vpn.isRunning()) {
            int port = vpn.getSocksPort();
            if (port > 0) activeSocksPort = port;
        }

        boolean success = false;

        for (int attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                try { Thread.sleep(2000); } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            long result = httpGetViaSocks(activeSocksPort, PING_HOST, 80, "/",
                PING_TIMEOUT_SECONDS * 1000);
            if (result >= 0) {
                success = true;
                Log.d(TAG, "SOCKS ping ok in " + result + "ms (attempt " + (attempt + 1) + ")");
                break;
            }
            Log.w(TAG, "SOCKS ping attempt " + (attempt + 1) + " failed");
        }

        lastPingTime = System.currentTimeMillis();
        lastPingSuccess = success;
        updateNotification();

        if (!success) Log.w(TAG, "All SOCKS ping attempts failed");
    }

    // Raw SOCKS5 handshake + HTTP GET — возвращает RTT в мс, или -1 при ошибке.
    // Использует удалённый DNS-резолв (ATYP=0x03), поэтому работает даже когда
    // системный DNS недоступен (белые списки РФ).
    private long httpGetViaSocks(int socksPort, String host, int port, String path, int timeoutMs) {
        long start = System.currentTimeMillis();
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", socksPort), timeoutMs);
            s.setSoTimeout(timeoutMs);
            java.io.OutputStream os = s.getOutputStream();
            java.io.InputStream is = s.getInputStream();

            // SOCKS5 greeting: VER=5, 1 method, no auth
            os.write(new byte[]{0x05, 0x01, 0x00});
            os.flush();
            byte[] hi = new byte[2];
            readFully(is, hi, 2);
            if (hi[0] != 0x05 || hi[1] != 0x00) return -1;

            // SOCKS5 CONNECT по домену (ATYP=0x03) — ядро резолвит само
            byte[] hb = host.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            byte[] req = new byte[7 + hb.length];
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
            req[4] = (byte) hb.length;
            System.arraycopy(hb, 0, req, 5, hb.length);
            req[5 + hb.length] = (byte) ((port >> 8) & 0xff);
            req[6 + hb.length] = (byte) (port & 0xff);
            os.write(req);
            os.flush();

            // Читаем ответ CONNECT
            byte[] rep = new byte[4];
            readFully(is, rep, 4);
            if (rep[1] != 0x00) return -1;
            int atyp = rep[3] & 0xff;
            int addrLen;
            if (atyp == 0x01) addrLen = 4;
            else if (atyp == 0x04) addrLen = 16;
            else if (atyp == 0x03) addrLen = readByte(is);
            else addrLen = 0;
            readFully(is, new byte[addrLen + 2], addrLen + 2);

            // HTTP GET
            String reqLine = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + host + "\r\n"
                + "User-Agent: SimProxy-AntiFilter\r\n"
                + "Connection: close\r\n\r\n";
            os.write(reqLine.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            os.flush();

            String statusLine = readLine(is);
            if (statusLine == null) return -1;
            // Любой валидный HTTP-ответ означает рабочий туннель
            if (statusLine.startsWith("HTTP")) return System.currentTimeMillis() - start;
            return -1;
        } catch (Exception t) {
            Log.d(TAG, "SOCKS ping error: " + t.getMessage());
            return -1;
        }
    }

    private static void readFully(java.io.InputStream is, byte[] buf, int len)
            throws java.io.IOException {
        int off = 0;
        while (off < len) {
            int r = is.read(buf, off, len - off);
            if (r < 0) throw new java.io.IOException("EOF");
            off += r;
        }
    }

    private static int readByte(java.io.InputStream is) throws java.io.IOException {
        int b = is.read();
        if (b < 0) throw new java.io.IOException("EOF");
        return b & 0xff;
    }

    private static String readLine(java.io.InputStream is) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = is.read()) >= 0) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    /**
     * Проверяет доступность порта (простой тест соединения).
     */
    private boolean isPortAccessible(int port) {
        try (java.net.Socket socket = new java.net.Socket()) {
            socket.connect(new java.net.InetSocketAddress("127.0.0.1", port), 3000);
            return true;
        } catch (Exception e) {
            Log.d(TAG, "Port " + port + " not accessible: " + e.getMessage());
            return false;
        }
    }

    /**
     * Запускает foreground notification.
     * ТРЕБУЕТСЯ для минимизации уничтожения сервиса системой.
     */
    private void startForegroundNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("AntiFilter Service")
            .setContentText("Maintaining connection through SOCKS proxy...")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } catch (Exception e) {
                Log.e(TAG, "startForeground failed", e);
                startForeground(NOTIFICATION_ID, notification);
            }
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        Log.i(TAG, "Foreground notification started");
    }

    /**
     * Обновляет foreground notification с текущим статусом.
     */
    private void updateNotification() {
        if (notificationManager == null) return;

        String statusText = "SOCKS port: " + activeSocksPort + " | " +
            (lastPingSuccess ? "✓ Connected" : "✗ Disconnected");

        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("AntiFilter Service")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build();

        notificationManager.notify(NOTIFICATION_ID, notification);
    }

    /**
     * Создаёт notification channel для service.
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "AntiFilter Service",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Lightweight SOCKS proxy keep-alive service");
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "AntiFilterService.onDestroy()");
        shouldKeepRunning.set(false);
        isRunning = false;

        if (pingExecutor != null) {
            pingExecutor.shutdown();
            try {
                if (!pingExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                    pingExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                pingExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            pingExecutor = null;
        }

        instance = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // Not a bound service
    }
}
