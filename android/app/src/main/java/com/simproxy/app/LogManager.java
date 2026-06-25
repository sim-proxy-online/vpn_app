package com.simproxy.app;

import android.content.Context;
import android.util.Log;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * LogManager — логирование событий VPN в файл и консоль.
 * Сохраняет логи в app-specific storage для последующего анализа.
 */
public class LogManager {
    private static final String TAG = "SimProxyLog";
    private static final String LOG_FILENAME = "sim_proxy.log";
    private static final int MAX_LOG_SIZE = 1024 * 1024; // 1 MB
    private static LogManager instance;
    private final Context context;
    private final File logFile;
    private final Executor executor = Executors.newSingleThreadExecutor();
    private final SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);

    private LogManager(Context context) {
        this.context = context;
        this.logFile = new File(context.getFilesDir(), LOG_FILENAME);
    }

    public static synchronized LogManager getInstance(Context context) {
        if (instance == null) {
            instance = new LogManager(context.getApplicationContext());
        }
        return instance;
    }

    public void info(String tag, String msg) {
        writeLog("INFO", tag, msg, null);
        Log.i(tag, msg);
    }

    public void debug(String tag, String msg) {
        writeLog("DEBUG", tag, msg, null);
        Log.d(tag, msg);
    }

    public void warn(String tag, String msg) {
        writeLog("WARN", tag, msg, null);
        Log.w(tag, msg);
    }

    public void error(String tag, String msg, Throwable t) {
        writeLog("ERROR", tag, msg, t);
        Log.e(tag, msg, t);
    }

    private void writeLog(String level, String tag, String msg, Throwable t) {
        executor.execute(() -> {
            try {
                // Rotate log if too large
                if (logFile.exists() && logFile.length() > MAX_LOG_SIZE) {
                    File backup = new File(context.getFilesDir(), LOG_FILENAME + ".1");
                    if (backup.exists()) backup.delete();
                    logFile.renameTo(backup);
                }

                String timestamp = dateFormat.format(new Date());
                String logLine = String.format("[%s] %s %s: %s\n", timestamp, level, tag, msg);
                
                try (BufferedWriter writer = new BufferedWriter(new FileWriter(logFile, true))) {
                    writer.write(logLine);
                    if (t != null) {
                        writer.write("  Exception: " + t.getMessage() + "\n");
                        for (StackTraceElement ste : t.getStackTrace()) {
                            writer.write("    at " + ste + "\n");
                        }
                    }
                }
            } catch (IOException e) {
                Log.e(TAG, "Failed to write log", e);
            }
        });
    }

    public String readLogs() {
        try {
            if (!logFile.exists()) return "";
            // return last 50 lines
            try (java.io.BufferedReader br = new java.io.BufferedReader(new java.io.FileReader(logFile))) {
                java.util.LinkedList<String> lines = new java.util.LinkedList<>();
                String line;
                while ((line = br.readLine()) != null) {
                    lines.add(line);
                    if (lines.size() > 50) lines.removeFirst();
                }
                return String.join("\n", lines);
            }
        } catch (IOException e) {
            return "Failed to read logs: " + e.getMessage();
        }
    }

    public void clearLogs() {
        executor.execute(() -> {
            if (logFile.exists()) logFile.delete();
        });
    }
}
